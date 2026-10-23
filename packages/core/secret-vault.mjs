import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_BINARY = "/usr/bin/security";
const KEYCHAIN_SERVICE = "com.aipi.companion";
const WINDOWS_TARGET_PREFIX = `${KEYCHAIN_SERVICE}:`;
const REFERENCE_PREFIX = "aipi-secret://";
const ENVELOPE_PREFIX = "aipi-envelope://";
const PRIVATE_KEY_PREFIX = "aipi-pkcs8://";
const VAULT_DATA_DIR = (process.env.AIPI_DATA || process.env.API_FORGE_DATA) && (process.env.AIPI_DATA || process.env.API_FORGE_DATA) !== "${PLUGIN_DATA}"
  ? (process.env.AIPI_DATA || process.env.API_FORGE_DATA)
  : path.join(os.homedir(), ".api-forge");
const KEYRING_FILE = path.join(VAULT_DATA_DIR, "vault-keyring.json");
const KEY_AGREEMENT = "ECDH-P256";
const CONTENT_ENCRYPTION = "AES-256-GCM";
const KEY_DERIVATION = "HKDF-SHA-256";
const ENVELOPE_VERSION = 1;
const SECRET_NAME = /(token|secret|password|passphrase|authorization|cookie|api.?key|private.?key)/i;

const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AipiCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);

  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    if (bytes.Length > 2560) throw new ArgumentException("Credential exceeds the Windows generic credential size limit.");
    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL {
        Type = 1,
        TargetName = target,
        CredentialBlobSize = (UInt32)bytes.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = "aipi"
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (bytes.Length > 0) Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
      Marshal.FreeCoTaskMem(blob);
      Array.Clear(bytes, 0, bytes.Length);
    }
  }

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      CREDENTIAL credential = Marshal.PtrToStructure<CREDENTIAL>(pointer);
      if (credential.CredentialBlobSize == 0) return String.Empty;
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      try { return Encoding.Unicode.GetString(bytes); }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int code = Marshal.GetLastWin32Error();
      if (code != 1168) throw new Win32Exception(code);
    }
  }
}
'@

$action = $env:AIPI_CREDENTIAL_ACTION
$target = $env:AIPI_CREDENTIAL_TARGET
if ($action -eq 'set') {
  $secret = [Console]::In.ReadToEnd()
  [AipiCredentialManager]::Write($target, $secret)
} elseif ($action -eq 'get') {
  $secret = [AipiCredentialManager]::Read($target)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))
} elseif ($action -eq 'delete') {
  [AipiCredentialManager]::Delete($target)
} else {
  throw 'Unsupported credential action.'
}
`;

const WINDOWS_CREDENTIAL_COMMAND = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");

export class SecretStorageError extends Error {
  constructor(message, code = "AIPI_SECRET_STORAGE_ERROR") {
    super(message);
    this.name = "SecretStorageError";
    this.code = code;
  }
}

export function isSecretReference(value) {
  return typeof value === "string" && value.startsWith(REFERENCE_PREFIX);
}

function referenceFor(scope) {
  return `${REFERENCE_PREFIX}${crypto.createHash("sha256").update(scope).digest("hex")}`;
}

function accountFor(reference) {
  return reference.slice(REFERENCE_PREFIX.length);
}

async function macOSKeychainAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    await fs.access(KEYCHAIN_BINARY);
    return true;
  } catch {
    return false;
  }
}

async function executableOnPath(name) {
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return executableOnPath("powershell.exe");
  }
}

function runProcess(command, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const limit = 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= limit) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= limit) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      const error = new Error(`Credential helper exited with code ${code}.`);
      error.exitCode = code;
      reject(error);
    });
    child.stdin.end(input);
  });
}

export function createLinuxSecretServiceVault({ binary, run = runProcess }) {
  return {
    provider: "linux-secret-service",
    service: KEYCHAIN_SERVICE,
    async set(reference, value) {
      try {
        await run(binary, ["store", "--label=AIPI local credential", "service", KEYCHAIN_SERVICE, "account", accountFor(reference)], { input: String(value) });
      } catch {
        throw new SecretStorageError("AIPI could not save a credential through Linux Secret Service.", "AIPI_SECRET_WRITE_FAILED");
      }
    },
    async get(reference) {
      try {
        const { stdout } = await run(binary, ["lookup", "service", KEYCHAIN_SERVICE, "account", accountFor(reference)]);
        return stdout.replace(/\r?\n$/, "");
      } catch {
        throw new SecretStorageError("AIPI could not unlock a credential through Linux Secret Service.", "AIPI_SECRET_READ_FAILED");
      }
    },
    async delete(reference) {
      try {
        await run(binary, ["clear", "service", KEYCHAIN_SERVICE, "account", accountFor(reference)]);
      } catch {
        throw new SecretStorageError("AIPI could not remove a credential from Linux Secret Service.", "AIPI_SECRET_DELETE_FAILED");
      }
    }
  };
}

export function createWindowsCredentialVault({ binary, run = runProcess }) {
  const invoke = (action, reference, input = "") => run(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_CREDENTIAL_COMMAND], {
    input,
    env: { AIPI_CREDENTIAL_ACTION: action, AIPI_CREDENTIAL_TARGET: `${WINDOWS_TARGET_PREFIX}${accountFor(reference)}` }
  });
  return {
    provider: "windows-credential-manager",
    service: KEYCHAIN_SERVICE,
    async set(reference, value) {
      try {
        await invoke("set", reference, String(value));
      } catch {
        throw new SecretStorageError("AIPI could not save a credential in Windows Credential Manager.", "AIPI_SECRET_WRITE_FAILED");
      }
    },
    async get(reference) {
      try {
        const { stdout } = await invoke("get", reference);
        return Buffer.from(stdout.trim(), "base64").toString("utf8");
      } catch {
        throw new SecretStorageError("AIPI could not unlock a credential from Windows Credential Manager.", "AIPI_SECRET_READ_FAILED");
      }
    },
    async delete(reference) {
      try {
        await invoke("delete", reference);
      } catch {
        throw new SecretStorageError("AIPI could not remove a credential from Windows Credential Manager.", "AIPI_SECRET_DELETE_FAILED");
      }
    }
  };
}

async function createSystemSecretVault() {
  if (process.platform === "darwin" && await macOSKeychainAvailable()) {
    return {
      provider: "macos-keychain",
      service: KEYCHAIN_SERVICE,
      async set(reference, value) {
        try {
          await execFileAsync(KEYCHAIN_BINARY, ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", accountFor(reference), "-w", String(value)], { maxBuffer: 1024 * 1024 });
        } catch {
          throw new SecretStorageError("AIPI could not save a credential in macOS Keychain.", "AIPI_SECRET_WRITE_FAILED");
        }
      },
      async get(reference) {
        try {
          const { stdout } = await execFileAsync(KEYCHAIN_BINARY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", accountFor(reference), "-w"], { maxBuffer: 1024 * 1024 });
          return stdout.replace(/\r?\n$/, "");
        } catch {
          throw new SecretStorageError("AIPI could not unlock a credential from macOS Keychain. Restore the credential or remove its workspace reference.", "AIPI_SECRET_READ_FAILED");
        }
      },
      async delete(reference) {
        try {
          await execFileAsync(KEYCHAIN_BINARY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", accountFor(reference)], { maxBuffer: 1024 * 1024 });
        } catch {
          throw new SecretStorageError("AIPI could not remove a credential from macOS Keychain.", "AIPI_SECRET_DELETE_FAILED");
        }
      }
    };
  }
  if (process.platform === "linux") {
    const binary = await executableOnPath("secret-tool");
    if (binary) return createLinuxSecretServiceVault({ binary });
  }
  if (process.platform === "win32") {
    const binary = await windowsPowerShellPath();
    if (binary) return createWindowsCredentialVault({ binary });
  }
  return null;
}

function privateKeyReference(keyId) {
  return `${REFERENCE_PREFIX}vault/private/${keyId}`;
}

function publicKeyFingerprint(publicKey) {
  const der = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").match(/.{1,4}/g).join(":");
}

function createVaultIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyMaterial = `${PRIVATE_KEY_PREFIX}${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`;
  const fingerprint = publicKeyFingerprint(publicKeyPem);
  const id = `key_${fingerprint.replaceAll(":", "").slice(0, 24)}`;
  return {
    privateKeyMaterial,
    metadata: { id, publicKey: publicKeyPem, fingerprint, createdAt: new Date().toISOString(), status: "active" }
  };
}

function privateKeyObject(material) {
  const value = String(material ?? "");
  if (value.startsWith(PRIVATE_KEY_PREFIX)) {
    return crypto.createPrivateKey({ key: Buffer.from(value.slice(PRIVATE_KEY_PREFIX.length), "base64url"), type: "pkcs8", format: "der" });
  }
  if (value.startsWith("-----BEGIN PRIVATE KEY-----")) return crypto.createPrivateKey(value);
  // Older macOS Keychain entries containing PEM newlines are returned by the
  // security CLI as a hexadecimal byte string. Decode them during migration.
  if (/^[a-f0-9]+$/i.test(value) && value.length % 2 === 0) {
    const decoded = Buffer.from(value, "hex").toString("utf8");
    if (decoded.startsWith("-----BEGIN PRIVATE KEY-----")) return crypto.createPrivateKey(decoded);
  }
  throw new SecretStorageError("AIPI could not decode the protected vault private key.", "AIPI_VAULT_PRIVATE_KEY_INVALID");
}

function normalizeKeyring(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.keys)) return null;
  const keys = value.keys.filter((entry) => entry?.id && entry?.publicKey && entry?.fingerprint);
  if (!keys.length || !keys.some((entry) => entry.id === value.activeKeyId)) return null;
  return { version: 1, activeKeyId: value.activeKeyId, updatedAt: value.updatedAt ?? null, keys };
}

async function readKeyring() {
  try {
    return normalizeKeyring(JSON.parse(await fs.readFile(KEYRING_FILE, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new SecretStorageError("The AIPI vault key registry is not valid JSON.", "AIPI_VAULT_KEYRING_INVALID");
    throw error;
  }
}

async function writeKeyring(keyring) {
  await fs.mkdir(VAULT_DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${KEYRING_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, KEYRING_FILE);
}

async function installVaultIdentity(backing, current = null) {
  const identity = createVaultIdentity();
  await backing.set(privateKeyReference(identity.metadata.id), identity.privateKeyMaterial);
  const now = new Date().toISOString();
  const previousKeys = (current?.keys ?? []).map((entry) => entry.id === current?.activeKeyId ? { ...entry, status: "retired", retiredAt: now } : entry);
  const keyring = { version: 1, activeKeyId: identity.metadata.id, updatedAt: now, keys: [...previousKeys, identity.metadata] };
  await writeKeyring(keyring);
  return keyring;
}

async function ensureKeyring(backing) {
  return await readKeyring() ?? installVaultIdentity(backing);
}

function envelopeAad(reference, keyId) {
  return Buffer.from(`aipi:vault:${ENVELOPE_VERSION}:${keyId}:${reference}`, "utf8");
}

function serializeEnvelope(envelope) {
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function parseEnvelope(value) {
  if (typeof value !== "string" || !value.startsWith(ENVELOPE_PREFIX)) return null;
  try {
    const envelope = JSON.parse(Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"));
    if (envelope.version !== ENVELOPE_VERSION || envelope.keyAgreement !== KEY_AGREEMENT || envelope.keyDerivation !== KEY_DERIVATION || envelope.contentEncryption !== CONTENT_ENCRYPTION) throw new Error("unsupported envelope");
    for (const field of ["keyId", "ephemeralPublicKey", "salt", "iv", "tag", "ciphertext"]) if (!envelope[field]) throw new Error(`missing ${field}`);
    return envelope;
  } catch {
    throw new SecretStorageError("A saved AIPI credential has an invalid encrypted envelope.", "AIPI_SECRET_ENVELOPE_INVALID");
  }
}

function deriveContentKey(sharedSecret, salt, aad) {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, aad, 32));
}

function encryptEnvelope(value, reference, identity) {
  const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: crypto.createPublicKey(identity.publicKey) });
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = envelopeAad(reference, identity.id);
  const key = deriveContentKey(sharedSecret, salt, aad);
  const plaintext = Buffer.from(String(value), "utf8");
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return serializeEnvelope({
      version: ENVELOPE_VERSION,
      keyAgreement: KEY_AGREEMENT,
      keyDerivation: KEY_DERIVATION,
      contentEncryption: CONTENT_ENCRYPTION,
      keyId: identity.id,
      ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    });
  } finally {
    plaintext.fill(0);
    sharedSecret.fill(0);
    key.fill(0);
  }
}

function decryptEnvelopeBytes(envelope, reference, privateKeyPem) {
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObject(privateKeyPem),
    publicKey: crypto.createPublicKey({ key: Buffer.from(envelope.ephemeralPublicKey, "base64url"), type: "spki", format: "der" })
  });
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const aad = envelopeAad(reference, envelope.keyId);
  const key = deriveContentKey(sharedSecret, salt, aad);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
  } catch {
    throw new SecretStorageError("AIPI could not authenticate or decrypt a saved credential.", "AIPI_SECRET_DECRYPT_FAILED");
  } finally {
    sharedSecret.fill(0);
    key.fill(0);
  }
}

function decryptEnvelope(envelope, reference, privateKeyPem) {
  const plaintext = decryptEnvelopeBytes(envelope, reference, privateKeyPem);
  try { return plaintext.toString("utf8"); }
  finally { plaintext.fill(0); }
}

function createEncryptedVault(backing) {
  return {
    provider: backing.provider,
    service: backing.service,
    encryption: { keyAgreement: KEY_AGREEMENT, keyDerivation: KEY_DERIVATION, contentEncryption: CONTENT_ENCRYPTION },
    async set(reference, value) {
      const keyring = await ensureKeyring(backing);
      const identity = keyring.keys.find((entry) => entry.id === keyring.activeKeyId);
      await backing.set(reference, encryptEnvelope(value, reference, identity));
    },
    async get(reference) {
      const stored = await backing.get(reference);
      const envelope = parseEnvelope(stored);
      if (!envelope) return stored;
      const keyring = await readKeyring();
      const identity = keyring?.keys.find((entry) => entry.id === envelope.keyId);
      if (!identity) throw new SecretStorageError(`The private key metadata for ${envelope.keyId} is unavailable.`, "AIPI_VAULT_KEY_NOT_FOUND");
      const privateKey = await backing.get(privateKeyReference(envelope.keyId));
      return decryptEnvelope(envelope, reference, privateKey);
    },
    async delete(reference) { await backing.delete(reference); }
  };
}

export async function createSecretVault() {
  const backing = await createSystemSecretVault();
  return backing ? createEncryptedVault(backing) : null;
}

async function keyringStatus(backing) {
  const keyring = await readKeyring();
  if (!keyring) return { initialized: false, keyCount: 0, retiredKeyCount: 0, activeKey: null, activePublicKey: null, privateKeyAvailable: false };
  const active = keyring.keys.find((entry) => entry.id === keyring.activeKeyId);
  let privateKeyAvailable = false;
  try { privateKeyAvailable = Boolean(await backing.get(privateKeyReference(active.id))); } catch {}
  return {
    initialized: true,
    keyCount: keyring.keys.length,
    retiredKeyCount: keyring.keys.filter((entry) => entry.status === "retired").length,
    activeKey: active ? { id: active.id, fingerprint: active.fingerprint, createdAt: active.createdAt } : null,
    activePublicKey: active?.publicKey ?? null,
    privateKeyAvailable
  };
}

export async function initializeSecretStorage() {
  const backing = await createSystemSecretVault();
  if (!backing) throw new SecretStorageError("AIPI cannot initialize encryption without a supported OS credential store.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  await ensureKeyring(backing);
  return secretStorageStatus();
}

export async function rotateSecretStorageKey() {
  const backing = await createSystemSecretVault();
  if (!backing) throw new SecretStorageError("AIPI cannot rotate encryption keys without a supported OS credential store.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  await installVaultIdentity(backing, await readKeyring());
  return secretStorageStatus();
}

export async function deleteSecretForScope(scope) {
  const backing = await createSystemSecretVault();
  if (!backing) throw new SecretStorageError("AIPI cannot remove credentials without a supported OS credential store.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  await backing.delete(referenceFor(scope));
}

export async function storeEncryptedSecretForScope(scope, serializedEnvelope) {
  const backing = await createSystemSecretVault();
  if (!backing) throw new SecretStorageError("AIPI cannot save credentials without a supported OS credential store.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  const keyring = await readKeyring();
  if (!keyring) throw new SecretStorageError("Initialize the AIPI secrets vault before adding credentials.", "AIPI_VAULT_NOT_INITIALIZED");
  const reference = referenceFor(scope);
  const envelopeText = typeof serializedEnvelope === "string" ? serializedEnvelope : serializeEnvelope(serializedEnvelope);
  const envelope = parseEnvelope(envelopeText);
  if (envelope.keyId !== keyring.activeKeyId) throw new SecretStorageError("The credential was encrypted for a retired vault key. Refresh vault status and try again.", "AIPI_VAULT_KEY_CHANGED");
  const identity = keyring.keys.find((entry) => entry.id === envelope.keyId);
  if (!identity) throw new SecretStorageError("The active AIPI vault key metadata is unavailable.", "AIPI_VAULT_KEY_NOT_FOUND");
  const privateKey = await backing.get(privateKeyReference(identity.id));
  const plaintext = decryptEnvelopeBytes(envelope, reference, privateKey);
  plaintext.fill(0);
  await backing.set(reference, envelopeText);
  return reference;
}

export async function storeSecretForScope(scope, value) {
  const vault = await createSecretVault();
  if (!vault) throw new SecretStorageError("AIPI cannot save credentials without a supported OS credential store.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  const keyring = await readKeyring();
  if (!keyring) throw new SecretStorageError("Initialize the AIPI secrets vault before capturing a browser session.", "AIPI_VAULT_NOT_INITIALIZED");
  const reference = referenceFor(scope);
  await vault.set(reference, String(value));
  return reference;
}

export async function secretStorageStatus() {
  const backing = await createSystemSecretVault();
  return backing
    ? { available: true, platform: process.platform, provider: backing.provider, service: backing.service, plaintextFallback: false, encryption: { keyAgreement: KEY_AGREEMENT, keyDerivation: KEY_DERIVATION, contentEncryption: CONTENT_ENCRYPTION, envelopeVersion: ENVELOPE_VERSION, ...await keyringStatus(backing) } }
    : {
        available: false,
        platform: process.platform,
        provider: null,
        service: null,
        plaintextFallback: false,
        reason: process.platform === "linux"
          ? "Linux Secret Service requires the secret-tool executable and an available desktop keyring."
          : process.platform === "win32"
            ? "Windows Credential Manager requires Windows PowerShell."
            : process.platform === "darwin"
              ? "macOS Keychain is unavailable."
              : `AIPI does not yet support the ${process.platform} credential store.`
      };
}

function cloneState(state) {
  return structuredClone(state);
}

function secretLocations(state) {
  const locations = [];
  for (const [projectIndex, project] of (state.projects ?? []).entries()) {
    const projectScope = `project:${project.id ?? projectIndex}`;
    for (const [environmentIndex, environment] of (project.environments ?? []).entries()) {
      const environmentScope = `${projectScope}:environment:${environment.id ?? environmentIndex}`;
      for (const [variableIndex, variable] of (environment.variables ?? []).entries()) {
        if (!variable?.secret && !SECRET_NAME.test(variable?.key ?? "")) continue;
        locations.push({
          owner: variable,
          field: "value",
          scope: `${environmentScope}:variable:${variable.key || variableIndex}${variable.vaultCredential && variable.credentialRefId ? `:credential:${variable.credentialRefId}` : ""}`
        });
      }
      for (const [serviceIndex, service] of (environment.services ?? []).entries()) {
        const serviceScope = `${environmentScope}:service:${service.id ?? service.variableKey ?? serviceIndex}`;
        for (const [variableIndex, variable] of (service.variables ?? []).entries()) {
          if (!variable?.secret && !SECRET_NAME.test(variable?.key ?? "")) continue;
          locations.push({
            owner: variable,
            field: "value",
            scope: `${serviceScope}:variable:${variable.key || variableIndex}${variable.vaultCredential && variable.credentialRefId ? `:credential:${variable.credentialRefId}` : ""}`
          });
        }
      }
    }
    for (const [requestIndex, request] of (project.requests ?? []).entries()) {
      const requestScope = `${projectScope}:request:${request.id ?? requestIndex}`;
      for (const field of ["token", "password", "value"]) {
        if (request.auth && field in request.auth) locations.push({ owner: request.auth, field, scope: `${requestScope}:auth:${field}` });
      }
      if (request.certificates && "clientKey" in request.certificates) {
        locations.push({ owner: request.certificates, field: "clientKey", scope: `${requestScope}:certificates:clientKey` });
      }
    }
  }
  return locations;
}

async function requireVault(vault) {
  const resolved = vault ?? await createSecretVault();
  if (!resolved) {
    throw new SecretStorageError("AIPI will not persist credentials because no supported OS credential store is available.", "AIPI_SECRET_STORAGE_UNAVAILABLE");
  }
  return resolved;
}

export async function protectStateSecrets(state, options = {}) {
  const protectedState = cloneState(state);
  let vault = options.vault ?? null;
  for (const location of secretLocations(protectedState)) {
    const value = location.owner[location.field];
    if (value === undefined || value === null || value === "" || isSecretReference(value)) continue;
    vault = await requireVault(vault);
    const reference = referenceFor(location.scope);
    await vault.set(reference, String(value));
    location.owner[location.field] = reference;
  }
  return protectedState;
}

export async function hydrateStateSecrets(state, options = {}) {
  const hydratedState = cloneState(state);
  let vault = options.vault ?? null;
  for (const location of secretLocations(hydratedState)) {
    const reference = location.owner[location.field];
    if (!isSecretReference(reference)) continue;
    vault = await requireVault(vault);
    location.owner[location.field] = await vault.get(reference);
  }
  return hydratedState;
}

export function redactStateSecrets(state, replacement = "[REDACTED]") {
  const redactedState = cloneState(state);
  for (const location of secretLocations(redactedState)) {
    const value = location.owner[location.field];
    if (value !== undefined && value !== null && value !== "") location.owner[location.field] = replacement;
  }
  return redactedState;
}

export function preserveRedactedStateSecrets(incoming, current, replacement = "[REDACTED]") {
  const merged = cloneState(incoming);
  const existing = new Map(secretLocations(current).map((location) => [location.scope, location.owner[location.field]]));
  for (const location of secretLocations(merged)) {
    if (location.owner[location.field] === replacement && existing.has(location.scope)) {
      location.owner[location.field] = existing.get(location.scope);
    }
  }
  return merged;
}

export const SECRET_REFERENCE_PREFIX = REFERENCE_PREFIX;
