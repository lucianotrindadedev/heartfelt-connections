import {
  db, agents, agentWarmupConfig, integrations, warmupSent, conversations,
  HelenaClient, logger, env,
} from "@sarai/shared";
import { eq, and, sql } from "drizzle-orm";

export async function runWarmupTick() {
  logger.info("warmup tick starting");

  try {
    const configs = await db.select()
      .from(agentWarmupConfig)
      .where(eq(agentWarmupConfig.enabled, true));

    for (const config of configs) {
      try {
        const [agent] = await db.select().from(agents)
          .where(and(eq(agents.id, config.agentId), eq(agents.enabled, true)));
        if (!agent) continue;

        // Get Clinicorp config
        const [clinicorpInt] = await db.execute(
          sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
              FROM integrations WHERE account_id = ${agent.accountId} AND type = 'clinicorp'`
        );
        if (!clinicorpInt?.config) continue;
        const clinicorpConfig = JSON.parse(clinicorpInt.config as string);

        // Get Helena config
        const [helenaInt] = await db.execute(
          sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
              FROM integrations WHERE account_id = ${agent.accountId} AND type = 'helena_crm'`
        );
        if (!helenaInt?.config) continue;
        const helenaConfig = JSON.parse(helenaInt.config as string);
        const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });

        // Fetch appointments for next 4 days from Clinicorp
        const startDate = new Date().toISOString().slice(0, 10);
        const endDate = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);

        const url = new URL("https://api.clinicorp.com/rest/v1/appointment/list");
        url.searchParams.set("subscriber_id", clinicorpConfig.subscriber_id);
        url.searchParams.set("from", startDate);
        url.searchParams.set("to", endDate);
        url.searchParams.set("businessId", clinicorpConfig.business_id);

        const aptRes = await fetch(url.toString(), {
          headers: {
            Authorization: `Basic ${clinicorpConfig.api_token}`,
            accept: "application/json",
          },
        });
        if (!aptRes.ok) continue;
        const appointments = await aptRes.json();
        if (!Array.isArray(appointments)) continue;

        // Filter by agenda_id (dentist) if configured
        const agendaId = config.subscriberId || clinicorpConfig.agenda_id;
        const filtered = agendaId
          ? appointments.filter((a: any) => String(a.Dentist_PersonId) === String(agendaId))
          : appointments;

        const windows = [
          { key: "WU1", hours: config.tempoWu1 },
          { key: "WU2", hours: config.tempoWu2 },
          { key: "WU3", hours: config.tempoWu3 },
          { key: "WU4", hours: config.tempoWu4 },
          { key: "WU5", hours: config.tempoWu5 },
        ];

        const prompts = config.prompts as Record<string, string>;

        for (const apt of filtered) {
          const aptDate = new Date(apt.fromTime || apt.dateTime || apt.date);
          const hoursUntil = (aptDate.getTime() - Date.now()) / 3600000;
          const aptId = String(apt.Id || apt.id || apt.appointmentId || "");

          // Get patient phone
          let phone = apt.Phone || apt.MobilePhone;
          if (!phone && apt.Patient_PersonId) {
            try {
              const patUrl = new URL("https://api.clinicorp.com/rest/v1/patient/get");
              patUrl.searchParams.set("subscriber_id", clinicorpConfig.subscriber_id);
              patUrl.searchParams.set("PatientId", String(apt.Patient_PersonId));
              const patRes = await fetch(patUrl.toString(), {
                headers: { Authorization: `Basic ${clinicorpConfig.api_token}`, accept: "application/json" },
              });
              if (patRes.ok) {
                const patient = await patRes.json();
                phone = patient.Phone || patient.MobilePhone;
              }
            } catch {}
          }
          if (!phone) continue;

          for (const w of windows) {
            // Check if within window (+-30 min tolerance)
            if (Math.abs(hoursUntil - w.hours) > 0.5) continue;

            // Dedup check
            const [already] = await db.select().from(warmupSent)
              .where(and(
                eq(warmupSent.accountId, agent.accountId),
                eq(warmupSent.appointmentId, aptId),
                eq(warmupSent.reminderType, w.key),
              ));
            if (already) continue;

            // Find Helena contact and session
            try {
              const contact = await helena.getContactByPhone(phone);
              if (!contact?.id) continue;

              const sessions = await helena.getSessionsByContact(contact.id);
              const session = sessions.items?.[0];
              if (!session?.id) continue;

              // Try to send template message
              // Get template for this warmup type
              if (session.channelId) {
                try {
                  const templates = await helena.getTemplates(session.channelId, "ATTENDANCE", w.key);
                  const template = templates.items?.[0];
                  if (template) {
                    const formattedDate = aptDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
                    const formattedTime = apt.fromTime ? new Date(apt.fromTime).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
                    await helena.sendTemplate(session.id, template.id, {
                      horario: `${formattedDate} às ${formattedTime}`,
                    });
                  } else {
                    // Fallback to plain text
                    const text = prompts[w.key.toLowerCase()] || `Lembrete da sua consulta.`;
                    await helena.sendMessage(session.id, text);
                  }
                } catch {
                  const text = prompts[w.key.toLowerCase()] || `Lembrete da sua consulta.`;
                  await helena.sendMessage(session.id, text);
                }
              } else {
                const text = prompts[w.key.toLowerCase()] || `Lembrete da sua consulta.`;
                await helena.sendMessage(session.id, text);
              }

              // Record sent
              await db.insert(warmupSent).values({
                accountId: agent.accountId,
                appointmentId: aptId,
                reminderType: w.key,
              });

              logger.info({ agentId: config.agentId, phone, type: w.key }, "warmup sent via Helena");
            } catch (e: any) {
              logger.warn({ phone, type: w.key, err: e.message }, "warmup contact/session not found");
            }
          }
        }
      } catch (e: any) {
        logger.error({ agentId: config.agentId, err: e.message }, "warmup failed for agent");
      }
    }
  } catch (e: any) {
    logger.error({ err: e.message }, "warmup tick failed");
  }
}
