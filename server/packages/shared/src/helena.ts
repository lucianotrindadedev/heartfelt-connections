/**
 * Complete Helena CRM API client.
 * Matches all endpoints used in n8n workflows 01-08.
 * 
 * Auth: All endpoints use header `Authorization: {token}` (raw token, NO "Bearer" prefix).
 * Base URL example: https://api.crmmentoriae7.com.br
 */

export interface HelenaConfig {
  baseUrl: string;  // e.g. https://api.crmmentoriae7.com.br
  token: string;    // raw token like pn_XXXX
}

export interface HelenaContact {
  id: string;
  name?: string;
  phonenumber?: string;
  tagNames?: string[];
  utm?: { content?: string; source?: string; medium?: string; campaign?: string };
  [key: string]: unknown;
}

export interface HelenaSession {
  id: string;
  contactId?: string;
  channelId?: string;
  status?: string;  // "PENDING", "OPEN", "CLOSED", etc.
  lastInteractionDate?: string;
  [key: string]: unknown;
}

export interface HelenaTemplate {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

export class HelenaClient {
  constructor(private cfg: HelenaConfig) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.cfg.token,  // RAW token, no Bearer prefix
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Helena ${res.status} ${init.method || "GET"} ${path}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Contacts ───

  /** Find contact by phone number */
  getContactByPhone(phone: string): Promise<HelenaContact> {
    return this.req(`/core/v1/contact/phonenumber/${encodeURIComponent(phone)}`);
  }

  /** Get contact details by ID (includes tagNames, utm) */
  getContact(contactId: string): Promise<HelenaContact> {
    return this.req(`/core/v1/contact/${contactId}`);
  }

  /** Add tags to contact (InsertIfNotExists) */
  addTags(contactId: string, tagNames: string[]): Promise<unknown> {
    return this.req(`/core/v1/contact/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ operation: "InsertIfNotExists", tagNames }),
    });
  }

  /** Remove tags from contact (DeleteIfExists) */
  removeTags(contactId: string, tagNames: string[]): Promise<unknown> {
    return this.req(`/core/v1/contact/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ operation: "DeleteIfExists", tagNames }),
    });
  }

  /** Replace all tags on contact */
  replaceTags(contactId: string, tagNames: string[]): Promise<unknown> {
    return this.req(`/core/v1/contact/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ operation: "ReplaceAll", tagNames }),
    });
  }

  /** List all available tags */
  listTags(): Promise<{ items: Array<{ id: string; name: string }> }> {
    return this.req(`/core/v1/tag`);
  }

  // ─── Sessions (Conversations) ───

  /** Get session details */
  getSession(sessionId: string): Promise<HelenaSession> {
    return this.req(`/chat/v2/session/${sessionId}`);
  }

  /** List sessions for a contact */
  getSessionsByContact(contactId: string): Promise<{ items: HelenaSession[] }> {
    return this.req(`/chat/v2/session?ContactId=${contactId}`);
  }

  /** Send text message to session */
  sendMessage(sessionId: string, text: string): Promise<{ id: string }> {
    return this.req(`/chat/v1/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /** Send file message to session */
  sendFile(sessionId: string, fileUrl: string, text?: string): Promise<{ id: string }> {
    return this.req(`/chat/v1/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ fileUrl, text: text || "" }),
    });
  }

  /** Send template message (sync) */
  sendTemplate(sessionId: string, templateId: string, parameters: Record<string, string>): Promise<unknown> {
    return this.req(`/chat/v1/session/${sessionId}/message/sync`, {
      method: "POST",
      body: JSON.stringify({ templateId, parameters }),
    });
  }

  // ─── Templates ───

  /** List templates by channel, type, and name */
  getTemplates(channelId: string, type: string, name: string): Promise<{ items: HelenaTemplate[] }> {
    return this.req(`/chat/v1/template?ChannelId=${channelId}&Type=${encodeURIComponent(type)}&Name=${encodeURIComponent(name)}`);
  }

  // ─── Sequences ───

  /** List sequences for a contact */
  getSequencesByContact(contactId: string): Promise<{ items: Array<{ id: string; name: string }> }> {
    return this.req(`/chat/v1/sequence?ContactId=${contactId}`);
  }

  /** Add contact to sequence */
  addToSequence(sequenceId: string, contactId: string, phoneNumber: string): Promise<unknown> {
    return this.req(`/chat/v1/sequence/${sequenceId}/contact/batch`, {
      method: "POST",
      body: JSON.stringify({ contactIds: [contactId], phoneNumbers: [phoneNumber] }),
    });
  }

  /** Remove contact from sequence */
  removeFromSequence(sequenceId: string, contactId: string, phoneNumber: string): Promise<unknown> {
    return this.req(`/chat/v1/sequence/${sequenceId}/contact/batch`, {
      method: "DELETE",
      body: JSON.stringify({ contactIds: [contactId], phoneNumbers: [phoneNumber] }),
    });
  }
}
