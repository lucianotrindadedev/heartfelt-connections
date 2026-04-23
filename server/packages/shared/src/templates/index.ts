import { clinicorpDental } from "./clinicorp_dental";

export const templates = {
  clinicorp_dental: clinicorpDental,
} as const;

export type TemplateKey = keyof typeof templates;
export { clinicorpDental };
