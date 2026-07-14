import { describe, it, expect } from "vitest";
import { sameBrazilPhone } from "./clinicorp.server";

// Guarda da dedup de paciente por nome+telefone (findClinicorpPatient): a busca
// por ?Phone= do Clinicorp não acha cadastros criados pelo agente, então caímos
// no fallback por nome e SÓ reutilizamos um cadastro cujo telefone bate. Um
// falso positivo aqui mesclaria dois pacientes diferentes de mesmo nome.
describe("sameBrazilPhone", () => {
  it("casa mesmo número em formatos diferentes (com/sem 55, formatado, number)", () => {
    // Caso real (Sorriamed Barra, Riordan Castro Carvalho): cadastro guarda
    // Phone como number 21970128245; lead chega como 5521970128245.
    expect(sameBrazilPhone(21970128245, "5521970128245")).toBe(true);
    expect(sameBrazilPhone("+55 (21) 97012-8245", "21970128245")).toBe(true);
    expect(sameBrazilPhone("5521970128245", "21970128245")).toBe(true);
  });

  it("tolera o nono dígito de celular (com e sem 9 após o DDD)", () => {
    expect(sameBrazilPhone(21970128245, "2170128245")).toBe(true);
  });

  it("NÃO casa telefones diferentes (homônimo com outro número → não mescla)", () => {
    expect(sameBrazilPhone(21970128245, "21988887777")).toBe(false);
    expect(sameBrazilPhone("21970128245", "11970128245")).toBe(false); // DDD diferente
  });

  it("vazio/curto demais nunca casa", () => {
    expect(sameBrazilPhone("", "")).toBe(false);
    expect(sameBrazilPhone(null, undefined)).toBe(false);
    expect(sameBrazilPhone("123", "123")).toBe(false);
  });
});
