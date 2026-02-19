/**
 * Default gearbox/vehicle lookup reply templates and helpers.
 * Tenant can override via tenants.templates (jsonb).
 */

export const DEFAULT_GEARBOX_TEMPLATES = {
  gearboxLookupFound:
    "По вашему VIN/FRAME получается коробка передач (OEM): {{oem}}.\nЕсли есть возможность — пришлите фото шильдика/маркировки КПП для сверки.\nЕсли сейчас не можете — продолжим подбор по OEM.\nИсточник: {{source}}.",
  gearboxLookupModelOnly:
    "По VIN/FRAME определяется модель КПП: {{model}}. OEM номер узла на сайте не отобразился.\nЕсли можете — пришлите фото шильдика/маркировки КПП, чтобы точно определить OEM.\nИсточник: {{source}}.",
  gearboxTagRequest:
    "Начал проверку по VIN/номеру кузова 👍\nЧтобы точно сверить коробку и исключить ошибку, если есть возможность — пришлите фото шильдика (маркировки) на коробке передач.\nЕсли сейчас не можете — ничего страшного, продолжу подбор по OEM.",
} as const;

export type GearboxTemplateKey = keyof typeof DEFAULT_GEARBOX_TEMPLATES;

export type GearboxTemplates = {
  gearboxLookupFound?: string | null;
  gearboxLookupModelOnly?: string | null;
  gearboxTagRequest?: string | null;
};

/** Raw tenant.templates from DB (may be null or partial). */
function getTenantTemplatesRaw(tenant: { templates?: unknown } | null | undefined): GearboxTemplates | null {
  if (!tenant) return null;
  const t = tenant.templates;
  if (t === null || t === undefined) return null;
  if (typeof t !== "object" || Array.isArray(t)) return null;
  return t as GearboxTemplates;
}

/** Merged templates: tenant overrides + defaults. Never null; missing keys use defaults. */
export function getMergedGearboxTemplates(tenant: { templates?: unknown } | null | undefined): typeof DEFAULT_GEARBOX_TEMPLATES {
  const raw = getTenantTemplatesRaw(tenant);
  return {
    gearboxLookupFound: (raw?.gearboxLookupFound != null && raw.gearboxLookupFound !== "")
      ? raw.gearboxLookupFound
      : DEFAULT_GEARBOX_TEMPLATES.gearboxLookupFound,
    gearboxLookupModelOnly: (raw?.gearboxLookupModelOnly != null && raw.gearboxLookupModelOnly !== "")
      ? raw.gearboxLookupModelOnly
      : DEFAULT_GEARBOX_TEMPLATES.gearboxLookupModelOnly,
    gearboxTagRequest: (raw?.gearboxTagRequest != null && raw.gearboxTagRequest !== "")
      ? raw.gearboxTagRequest
      : DEFAULT_GEARBOX_TEMPLATES.gearboxTagRequest,
  };
}

export type FillParams = { oem?: string | null; model?: string | null; source?: string | null };

/** Replace {{oem}}, {{model}}, {{source}} in template. Null/undefined -> empty string. */
export function fillGearboxTemplate(template: string, params: FillParams): string {
  const oem = params.oem ?? "";
  const model = params.model ?? "";
  const source = params.source ?? "";
  return template
    .replace(/\{\{oem\}\}/g, oem)
    .replace(/\{\{model\}\}/g, model)
    .replace(/\{\{source\}\}/g, source);
}
