import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import {
  applyModelSettingsPatch,
  emptyModelSettings,
  maskSecret,
  mergeModelSettings,
  toPublicModelSettings,
} from "../../src/settings/model-settings";
import {
  loadStoredModelSettings,
  resetSettingsCache,
  saveStoredModelSettings,
  getEffectiveModelSettings,
} from "../../src/settings/store";

describe("model-settings helpers", () => {
  it("masks secrets", () => {
    expect(maskSecret("sk-abcdefghij")).toMatch(/^sk-•+ghij$/);
    expect(maskSecret("short")).toBe("••••••••");
  });

  it("merge prefers stored over env", () => {
    const stored = emptyModelSettings();
    stored.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "stored-key",
      model: "deepseek-chat",
    };
    const merged = mergeModelSettings(stored, {
      LLM_BASE_URL: "https://env.example/v1",
      LLM_API_KEY: "env-key",
      LLM_MODEL: "env-model",
    });
    expect(merged.llm.apiKey).toBe("stored-key");
    expect(merged.llm.baseURL).toContain("deepseek");
  });

  it("patch keeps previous apiKey when masked", () => {
    const prev = emptyModelSettings();
    prev.llm.apiKey = "sk-real-secret-key";
    prev.llm.baseURL = "https://api.deepseek.com/v1";
    prev.llm.model = "deepseek-chat";
    prev.llm.provider = "deepseek";

    const next = applyModelSettingsPatch(prev, {
      llm: { apiKey: "sk-••••key", model: "deepseek-reasoner" },
    });
    expect(next.llm.apiKey).toBe("sk-real-secret-key");
    expect(next.llm.model).toBe("deepseek-reasoner");
  });

  it("public view never leaks full key", () => {
    const effective = emptyModelSettings();
    effective.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-super-secret-value",
      model: "deepseek-chat",
    };
    const pub = toPublicModelSettings(effective, {
      hasStored: true,
      hasEnvLlm: false,
      hasEnvEmbed: false,
    });
    expect(pub.llm.apiKey).not.toContain("super-secret");
    expect(pub.llm.hasApiKey).toBe(true);
    expect(pub.presets.llm.length).toBeGreaterThan(0);
  });
});

describe("settings store (sqlite)", () => {
  let dbPath: string;
  let raw: Database.Database;
  let d1: SqliteD1Database;

  beforeEach(() => {
    resetSettingsCache();
    dbPath = path.join(os.tmpdir(), `sb-settings-${Date.now()}.db`);
    raw = new Database(dbPath);
    d1 = new SqliteD1Database(raw);
  });

  afterEach(() => {
    resetSettingsCache();
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("saves and loads model settings", async () => {
    const db = d1 as unknown as D1Database;
    const settings = emptyModelSettings();
    settings.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
    };
    await saveStoredModelSettings(db, settings);
    resetSettingsCache();
    const loaded = await loadStoredModelSettings(db);
    expect(loaded?.llm.model).toBe("deepseek-chat");
    expect(loaded?.llm.apiKey).toBe("sk-test");
  });

  it("getEffective merges store + env", async () => {
    const db = d1 as unknown as D1Database;
    const settings = emptyModelSettings();
    settings.llm = {
      provider: "custom",
      baseURL: "https://llm.example/v1",
      apiKey: "k1",
      model: "m1",
    };
    await saveStoredModelSettings(db, settings);

    const { effective } = await getEffectiveModelSettings({
      DB: db,
      LLM_BASE_URL: "https://env/v1",
      LLM_API_KEY: "env",
    });
    expect(effective.llm.baseURL).toBe("https://llm.example/v1");
  });
});
