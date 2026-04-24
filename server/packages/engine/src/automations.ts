import { Worker } from "bullmq";
import {
  redis, logger, db, agents, integrations, conversations,
  HelenaClient, env,
} from "@sarai/shared";
import { eq, sql } from "drizzle-orm";

// ─── Clinicorp event worker (Faltosos - workflow 08 part 1) ─────────────────

export const clinicorpWorker = new Worker(
  "clinicorp-event",
  async (job) => {
    const { agentId, statusId, professionalId, patientId, appointmentId } = job.data;

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return;

    // Get Clinicorp config
    const [clinicorpInt] = await db.execute(
      sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
          FROM integrations WHERE account_id = ${agent.accountId} AND type = 'clinicorp'`
    );
    if (!clinicorpInt?.config) return;
    const clinicorpConfig = JSON.parse(clinicorpInt.config as string);

    // Filter by agenda_id (doctor)
    if (clinicorpConfig.agenda_id && String(professionalId) !== String(clinicorpConfig.agenda_id)) return;

    // Get status list and check if "Faltou" (8th status, index 7)
    const statusUrl = new URL("https://api.clinicorp.com/rest/v1/appointment/status_list");
    statusUrl.searchParams.set("subscriber_id", clinicorpConfig.subscriber_id);
    const statusRes = await fetch(statusUrl.toString(), {
      headers: { Authorization: `Basic ${clinicorpConfig.api_token}`, accept: "application/json" },
    });
    if (!statusRes.ok) return;
    const statusList = await statusRes.json();
    if (!Array.isArray(statusList) || statusList.length < 8) return;

    const faltouId = statusList[7]?.id || statusList[7]?.Id;
    if (String(statusId) !== String(faltouId)) return;

    // Patient missed appointment - get patient phone
    const patUrl = new URL("https://api.clinicorp.com/rest/v1/patient/get");
    patUrl.searchParams.set("subscriber_id", clinicorpConfig.subscriber_id);
    patUrl.searchParams.set("PatientId", String(patientId));
    const patRes = await fetch(patUrl.toString(), {
      headers: { Authorization: `Basic ${clinicorpConfig.api_token}`, accept: "application/json" },
    });
    if (!patRes.ok) return;
    const patient = await patRes.json();
    const phone = patient.Phone || patient.MobilePhone;
    if (!phone) return;

    // Get Helena config
    const [helenaInt] = await db.execute(
      sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
          FROM integrations WHERE account_id = ${agent.accountId} AND type = 'helena_crm'`
    );
    if (!helenaInt?.config) return;
    const helenaConfig = JSON.parse(helenaInt.config as string);
    const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });

    // Find contact
    try {
      const contact = await helena.getContactByPhone(phone);
      if (!contact?.id) return;

      // Remove scheduling tags
      await helena.removeTags(contact.id, ["IA Agendou", "CRC Agendou"]).catch(() => {});
      // Add "FALTOSOS" tag
      await helena.addTags(contact.id, ["FALTOSOS"]).catch(() => {});

      // Add to sequence if configured
      const sequenceId = clinicorpConfig.faltosos_sequence_id;
      if (sequenceId) {
        await helena.addToSequence(sequenceId, contact.id, phone).catch(() => {});
      }

      logger.info({ phone, appointmentId }, "faltoso processed");
    } catch (e: any) {
      logger.error({ phone, err: e.message }, "faltoso processing failed");
    }
  },
  { connection: redis, concurrency: 5 },
);

// ─── Helena tag event worker (FUF Financeiro - workflow 08 part 2) ──────────

export const helenaTagWorker = new Worker(
  "helena-tag-event",
  async (job) => {
    const { agentId, contactId, phone, tagNames } = job.data;

    // Check if "FUF FINANCEIRO" tag was added
    const tags = (tagNames || []).map((t: string) => t.toUpperCase());
    if (!tags.includes("FUF FINANCEIRO")) return;

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return;

    // Get Helena config
    const [helenaInt] = await db.execute(
      sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
          FROM integrations WHERE account_id = ${agent.accountId} AND type = 'helena_crm'`
    );
    if (!helenaInt?.config) return;
    const helenaConfig = JSON.parse(helenaInt.config as string);
    const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });

    // Pause IA
    await helena.addTags(contactId, ["IA Desligada"]).catch(() => {});

    // Add to FUF sequence if configured
    const fufSequenceId = helenaConfig.fuf_sequence_id;
    if (fufSequenceId && contactId && phone) {
      await helena.addToSequence(fufSequenceId, contactId, phone).catch(() => {});
    }

    logger.info({ contactId, phone }, "FUF financeiro processed");
  },
  { connection: redis, concurrency: 5 },
);

clinicorpWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "clinicorp event failed");
});

helenaTagWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "helena tag event failed");
});
