/**
 * Evolution API client - ONLY used for sending group alerts.
 * Main messaging goes through Helena CRM directly.
 */
export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
}

export class EvolutionClient {
  constructor(private cfg: EvolutionConfig) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        apikey: this.cfg.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Evolution ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** Send text to a WhatsApp group (used for alerts) */
  async sendGroupAlert(groupJid: string, text: string): Promise<void> {
    await this.post(`/message/sendText/${this.cfg.instanceName}`, {
      number: groupJid,
      text,
    });
  }
}
