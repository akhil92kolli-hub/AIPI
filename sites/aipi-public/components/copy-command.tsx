"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
export function CopyCommand({ command }: { command: string }) { const [copied, setCopied] = useState(false); async function copy() { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } return <div className="command-line"><code><span>$</span> {command}</code><button type="button" onClick={copy} aria-label="Copy install command">{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? "Copied" : "Copy"}</span></button></div>; }
