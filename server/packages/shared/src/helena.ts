/**
 * Cliente do CRM Helena.
 * Endpoints inferidos dos fluxos n8n 01/04/05/08.
 */
export interface HelenaConfig {
  baseUrl: string;
  token: string;
}

export class HelenaClient {
  constructor(private cfg: HelenaConfig) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Helena ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  getContactByPhone(phone: string) {
    return this.req<{ id: string; conversation_id?: string }>(
      `/core/v1/contact/phonenumber/${encodeURIComponent(phone)}`,
    );
  }

  postMessage(sessionId: string, content: string) {
    return this.req<{ id: string }>(`/chat/v1/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ content, type: "text" }),
    });
  }

  addTag(contactId: string, tag: string) {
    return this.req(`/core/v1/contact/${contactId}/tag`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    });
  }

  removeTag(contactId: string, tag: string) {
    return this.req(`/core/v1/contact/${contactId}/tag/${encodeURIComponent(tag)}`, {
      method: "DELETE",
    });
  }
}
