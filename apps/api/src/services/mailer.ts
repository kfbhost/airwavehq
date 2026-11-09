import nodemailer from "nodemailer";
import { config } from "../config.js";

let cached: nodemailer.Transporter | null | undefined;

function buildTransport(): nodemailer.Transporter | null {
  const m = config.mail;
  if (m.smtpHost) {
    return nodemailer.createTransport({
      host: m.smtpHost,
      port: m.smtpPort,
      secure: m.smtpSecure,
      auth: m.smtpUser ? { user: m.smtpUser, pass: m.smtpPass } : undefined,
    });
  }
  if (m.transport === "sendmail") {
    return nodemailer.createTransport({ sendmail: true, newline: "unix", path: m.sendmailPath });
  }
  return null;
}

function transport(): nodemailer.Transporter | null {
  if (cached === undefined) cached = buildTransport();
  return cached;
}

/** True when a mail transport and a From address are configured. */
export function mailConfigured(): boolean {
  return transport() !== null && !!config.mail.from;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html: string }): Promise<SendResult> {
  const t = transport();
  if (!t || !config.mail.from) return { sent: false, error: "Email is not configured on this server." };
  try {
    await t.sendMail({ from: config.mail.from, ...opts });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}

/** Sends the "you're invited" email. Never throws — callers fall back to the copy-paste link. */
export async function sendInviteEmail(params: {
  to: string;
  role: "admin" | "dj";
  acceptUrl: string;
  invitedByName: string;
  stationName: string;
}): Promise<SendResult> {
  const roleLabel = params.role === "admin" ? "an administrator" : "a DJ";
  const subject = `You're invited to ${params.stationName}`;
  const text =
    `${params.invitedByName} has invited you to join ${params.stationName} as ${roleLabel}.\n\n` +
    `Open this link to set your password and sign in (it expires in 7 days):\n${params.acceptUrl}\n\n` +
    `If the link doesn't work, ask ${params.invitedByName} to send a new invite.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#0f172a">` +
    `<h2 style="margin:0 0 8px">You're invited to ${escapeHtml(params.stationName)}</h2>` +
    `<p>${escapeHtml(params.invitedByName)} has invited you to join as <strong>${roleLabel}</strong>.</p>` +
    `<p style="margin:24px 0"><a href="${params.acceptUrl}" style="background:#3b82f6;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Accept invitation &amp; set your password</a></p>` +
    `<p style="color:#64748b;font-size:13px">This link expires in 7 days. If the button doesn't work, paste this into your browser:<br>${params.acceptUrl}</p>` +
    `</div>`;
  return sendMail({ to: params.to, subject, text, html });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
