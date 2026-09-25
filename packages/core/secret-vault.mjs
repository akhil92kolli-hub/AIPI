import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_BINARY = "/usr/bin/security";
const KEYCHAIN_SERVICE = "com.aipi.companion";
const WINDOWS_TARGET_PREFIX = `${KEYCHAIN_SERVICE}:`;
const REFERENCE_PREFIX = "aipi-secret://";
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

export async function createSecretVault() {
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

export async function secretStorageStatus() {
  const vault = await createSecretVault();
  return vault
    ? { available: true, platform: process.platform, provider: vault.provider, service: vault.service, plaintextFallback: false }
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
          scope: `${environmentScope}:variable:${variable.key || variableIndex}`
        });
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
