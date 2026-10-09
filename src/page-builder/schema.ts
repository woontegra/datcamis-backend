import { z } from "zod";

export const visibilitySchema = z.object({
  desktop: z.boolean(),
  tablet: z.boolean(),
  mobile: z.boolean(),
});

export const spacingSchema = z.object({
  top: z.number().int().min(0).max(240),
  right: z.number().int().min(0).max(240),
  bottom: z.number().int().min(0).max(240),
  left: z.number().int().min(0).max(240),
});

const blockBase = {
  id: z.string().min(1).max(80),
  visibility: visibilitySchema,
  spacing: spacingSchema,
};

const textProps = {
  eyebrow: z.string().max(80).default(""),
  title: z.string().max(180).default(""),
  body: z.string().max(4000).default(""),
};

export const blockSchema = z.discriminatedUnion("type", [
  z.object({
    ...blockBase,
    type: z.literal("hero"),
    props: z.object({
      eyebrow: z.string().max(80).default(""),
      title: z.string().min(1).max(180),
      text: z.string().max(600).default(""),
      ctaLabel: z.string().max(40).default(""),
      ctaHref: z.string().max(200).default(""),
    }),
  }),
  z.object({ ...blockBase, type: z.literal("text"), props: z.object(textProps) }),
  z.object({
    ...blockBase,
    type: z.literal("image"),
    props: z.object({
      mediaId: z.string().max(80).default(""),
      alt: z.string().max(180).default(""),
      caption: z.string().max(240).default(""),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("product-list"),
    props: z.object({
      title: z.string().max(120).default(""),
      collectionSlug: z.string().max(80).default(""),
      categorySlug: z.string().max(80).default(""),
      limit: z.number().int().min(1).max(24).default(4),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("collection"),
    props: z.object({ slug: z.string().max(80).default(""), title: z.string().max(120).default("") }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("category"),
    props: z.object({ slug: z.string().max(80).default(""), title: z.string().max(120).default("") }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("slider"),
    props: z.object({
      slides: z.array(z.object({
        title: z.string().max(120),
        text: z.string().max(300).default(""),
        href: z.string().max(200).default(""),
      })).max(8),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("gallery"),
    props: z.object({ mediaIds: z.array(z.string().max(80)).max(12) }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("columns"),
    props: z.object({
      items: z.array(z.object({ title: z.string().max(80), text: z.string().max(300) })).min(2).max(4),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("feature-strip"),
    props: z.object({
      items: z.array(z.object({ title: z.string().max(80), text: z.string().max(240) })).min(1).max(6),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("campaign"),
    props: z.object({
      title: z.string().max(140),
      text: z.string().max(400).default(""),
      href: z.string().max(200).default(""),
      ctaLabel: z.string().max(40).default(""),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("countdown"),
    props: z.object({ title: z.string().max(140), endsAt: z.string().datetime() }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("blog"),
    props: z.object({ title: z.string().max(120).default(""), limit: z.number().int().min(1).max(6).default(3) }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("newsletter"),
    props: z.object({ title: z.string().max(140), text: z.string().max(300).default("") }),
  }),
  z.object({
    ...blockBase,
    type: z.literal("spacer"),
    props: z.object({ size: z.number().int().min(8).max(160).default(32) }),
  }),
]);

export const sectionSchema = z.object({
  id: z.string().min(1).max(80),
  visibility: visibilitySchema,
  spacing: spacingSchema,
  contained: z.boolean().default(true),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
  blocks: z.array(blockSchema).max(24),
});

export const homeEditorSlug = "ana-sayfa";

export const pageDocumentV1Schema = z.object({
  version: z.literal(1),
  sections: z.array(sectionSchema).max(40),
});

const editableTextId = new RegExp(
  "^(?:home\\.(?:hero\\.(?:kicker|title|text|script)" +
    "|features\\.(?:natural|lasting|place|gift)\\.text" +
    "|collections\\.(?:title|card\\.[a-z0-9-]+\\.(?:title|kicker|action))" +
    "|products\\.(?:kicker|title|text)" +
    "|story\\.(?:title|text|script)" +
    "|promos\\.card\\.[a-z0-9-]+\\.(?:title|text|action))" +
    "|frame\\.(?:header\\.brand\\.(?:name|tag)" +
    "|footer\\.(?:brand\\.(?:name|tag|text)|(?:collections|house)\\.title|newsletter\\.(?:kicker|title|text))))$",
);

// Tablet and phone overrides hold only layout settings; fonts there may not go below 12 px.
const DEVICE_MIN_FONT = 12;

const copyStyleSchema = z.object({
  fontFamily: z.enum(["display", "sans", "script"]).optional(),
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional(),
  fontSize: z.number().int().min(8).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  lineHeight: z.number().min(0.8).max(3).optional(),
  letterSpacing: z.number().min(-5).max(20).optional(),
  spaceTop: z.number().int().min(0).max(48).optional(),
  spaceBottom: z.number().int().min(0).max(48).optional(),
  width: z.object({
    value: z.number().int(),
    unit: z.enum(["px", "%"]),
  }).optional(),
});

function copyWidthIssue(value: { width?: { value: number; unit: "px" | "%" } }, context: z.RefinementCtx) {
  if (!value.width) return;
  const percent = value.width.unit === "%";
  const min = percent ? 20 : 80;
  const max = percent ? 100 : 1200;
  if (value.width.value < min || value.width.value > max) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: percent ? "Yüzde genişlik 20 ile 100 arasında olmalı." : "Piksel genişlik 80 ile 1200 arasında olmalı." });
  }
}

const copyDeviceSchema = copyStyleSchema
  .omit({ color: true })
  .extend({ fontSize: z.number().int().min(DEVICE_MIN_FONT).max(120).optional() })
  .strict()
  .superRefine(copyWidthIssue);

const editorCopySchema = copyStyleSchema
  .extend({ text: z.string().max(2000).optional(), tablet: copyDeviceSchema.optional(), mobile: copyDeviceSchema.optional() })
  .superRefine(copyWidthIssue);

const editableLinkId = /^(?:home\.(?:hero|story)\.cta|home\.collections\.more|home\.(?:collections|promos)\.card\.[a-z0-9-]+|frame\.header\.nav\.[a-z0-9-]+|frame\.footer\.(?:collections|house)\.(?!title$)[a-z0-9-]+)$/;

export function isSafeHref(raw: string) {
  const href = raw.trim();
  if (!href || href.length > 300 || href !== raw) return false;
  if (/[\s\\\u0000-\u001f\u007f]/.test(href) || href.startsWith("//")) return false;
  if (href.startsWith("/") || href.startsWith("#")) return true;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  if (scheme === "mailto" || scheme === "tel") return true;
  if (scheme !== "https") return false;
  try {
    return new URL(href).hostname.length > 0;
  } catch {
    return false;
  }
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const linkSpace = z.number().int().min(0).max(96);

const linkDeviceSchema = z.object({
  fontSize: z.number().int().min(DEVICE_MIN_FONT).max(64).optional(),
  width: z.number().int().min(40).max(800).optional(),
  height: z.number().int().min(20).max(200).optional(),
  borderWidth: z.number().int().min(0).max(8).optional(),
  borderColor: hexColor.optional(),
  radius: z.number().int().min(0).max(999).optional(),
  paddingY: z.number().int().min(0).max(64).optional(),
  paddingX: z.number().int().min(0).max(64).optional(),
  marginTop: linkSpace.optional(),
  marginRight: linkSpace.optional(),
  marginBottom: linkSpace.optional(),
  marginLeft: linkSpace.optional(),
}).strict();

const editorLinkSchema = z.object({
  text: z.string().min(1).max(120).regex(/^[^\n\r]*$/).optional(),
  href: z.string().max(300).refine(isSafeHref, "Bağlantı adresi güvenli değil.").optional(),
  background: hexColor.optional(),
  color: hexColor.optional(),
  tablet: linkDeviceSchema.optional(),
  mobile: linkDeviceSchema.optional(),
  fontSize: z.number().int().min(8).max(64).optional(),
  width: z.number().int().min(40).max(800).optional(),
  height: z.number().int().min(20).max(200).optional(),
  borderWidth: z.number().int().min(0).max(8).optional(),
  borderColor: hexColor.optional(),
  radius: z.number().int().min(0).max(999).optional(),
  paddingY: z.number().int().min(0).max(64).optional(),
  paddingX: z.number().int().min(0).max(64).optional(),
  marginTop: linkSpace.optional(),
  marginRight: linkSpace.optional(),
  marginBottom: linkSpace.optional(),
  marginLeft: linkSpace.optional(),
});

const photoImageId = /^home\.hero\.photo$/;
const coverImageId = /^home\.(?:collections\.card\.[a-z0-9-]+\.photo|story\.photo|promos\.card\.[a-z0-9-]+\.photo)$/;
const markImageId = /^frame\.(?:header\.brand\.mark|footer\.brand\.mark|garden\.(?:desktop|mobile))$/;

export const editorImageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

const imageDeviceSchema = z.object({
  width: z.number().int().min(40).max(1600).optional(),
  height: z.number().int().min(40).max(1200).optional(),
  radius: z.number().int().min(0).max(200).optional(),
  borderWidth: z.number().int().min(0).max(12).optional(),
  borderColor: hexColor.optional(),
}).strict();

const editorImageSchema = z.object({
  tablet: imageDeviceSchema.optional(),
  mobile: imageDeviceSchema.optional(),
  mediaId: z.string().regex(/^[a-z0-9]{20,40}$/).optional(),
  fit: z.enum(["cover", "contain"]).optional(),
  focusX: z.number().int().min(0).max(100).optional(),
  focusY: z.number().int().min(0).max(100).optional(),
  width: z.number().int().min(40).max(1600).optional(),
  height: z.number().int().min(40).max(1200).optional(),
  radius: z.number().int().min(0).max(200).optional(),
  borderWidth: z.number().int().min(0).max(12).optional(),
  borderColor: hexColor.optional(),
});

type EditorImage = z.infer<typeof editorImageSchema>;

function imageIssue(id: string, image: EditorImage) {
  const keys = Object.keys(image);
  if (photoImageId.test(id)) return null;
  if (coverImageId.test(id)) {
    return keys.every((key) => ["mediaId", "fit", "focusX", "focusY"].includes(key)) ? null : "Bu görselde yalnızca görsel, sığdırma ve odak değiştirilebilir.";
  }
  if (markImageId.test(id)) {
    return keys.every((key) => key === "mediaId") ? null : "Bu görselde yalnızca görsel değiştirilebilir.";
  }
  return "Bu görsel editörden değiştirilemez.";
}

const editableBoxId = /^home\.(?:hero|features|collections|products|story|promos|hero\.(?:copy|visual)|story\.copy|collections\.grid|products\.grid|(?:collections|promos)\.card\.[a-z0-9-]+|features\.(?:natural|lasting|place|gift)|products\.card\.[a-z0-9-]+(?:\.body)?)$/;

const boxSpace = z.number().int().min(0).max(400);

const boxDeviceSchema = z.object({
  width: z.number().int().min(40).max(2000).optional(),
  height: z.number().int().min(20).max(2000).optional(),
  minHeight: z.number().int().min(0).max(2000).optional(),
  paddingTop: boxSpace.optional(),
  paddingRight: boxSpace.optional(),
  paddingBottom: boxSpace.optional(),
  paddingLeft: boxSpace.optional(),
  marginTop: boxSpace.optional(),
  marginRight: boxSpace.optional(),
  marginBottom: boxSpace.optional(),
  marginLeft: boxSpace.optional(),
}).strict();

const editorBoxSchema = z.object({
  tablet: boxDeviceSchema.optional(),
  mobile: boxDeviceSchema.optional(),
  background: hexColor.optional(),
  backgroundMediaId: z.string().regex(/^[a-z0-9]{20,40}$/).optional(),
  width: z.number().int().min(40).max(2000).optional(),
  height: z.number().int().min(20).max(2000).optional(),
  minHeight: z.number().int().min(0).max(2000).optional(),
  borderWidth: z.number().int().min(0).max(20).optional(),
  borderColor: hexColor.optional(),
  radius: z.number().int().min(0).max(400).optional(),
  shadow: z.object({
    x: z.number().int().min(-100).max(100),
    y: z.number().int().min(-100).max(100),
    blur: z.number().int().min(0).max(200),
    color: hexColor,
    opacity: z.number().int().min(0).max(100),
  }).optional(),
  opacity: z.number().int().min(10).max(100).optional(),
  paddingTop: boxSpace.optional(),
  paddingRight: boxSpace.optional(),
  paddingBottom: boxSpace.optional(),
  paddingLeft: boxSpace.optional(),
  marginTop: boxSpace.optional(),
  marginRight: boxSpace.optional(),
  marginBottom: boxSpace.optional(),
  marginLeft: boxSpace.optional(),
});

const editorLayerSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  type: z.literal("text"),
  parentId: z.string().regex(/^home\.collections\.card\.[a-z0-9-]+$/),
  text: z.string().max(500),
  desktop: z.object({
    x: z.number().int().min(0).max(4000),
    y: z.number().int().min(0).max(4000),
    width: z.number().int().min(1).max(4000),
    height: z.number().int().min(1).max(4000),
  }),
});

const mediaId = z.string().regex(/^[a-z0-9]{20,40}$/);
// Must match the frontend icon list (editor-icons.tsx); documents only store the name.
const nodeIcons = ["leaf", "flower", "drop", "star", "heart", "sun", "gift", "wave", "check", "truck", "phone", "mail", "pin", "arrow"] as const;
const MAX_NODES = 200;
const MAX_NODE_DEPTH = 4;
const nodeId = /^[a-f0-9]{8}$/;
// Product cards and grids are excluded: free elements may not sit on catalogue data.
const nodeHostId = /^home\.(?:hero|features|collections|story|promos|hero\.(?:copy|visual)|story\.copy|collections\.grid|(?:collections|promos)\.card\.[a-z0-9-]+|features\.(?:natural|lasting|place|gift))$/;

const nodeBox = z.object({
  x: z.number().int().min(0).max(4000),
  y: z.number().int().min(0).max(4000),
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
}).strict();
const nodeFrame = z.object({
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
}).strict();
// Desktop is the default design; tablet and mobile layouts are optional overrides.
const nodeLayout = z.object({
  box: nodeBox,
  frame: nodeFrame.optional(),
  fontSize: z.number().int().min(DEVICE_MIN_FONT).max(120).optional(),
  lineHeight: z.number().min(0.8).max(3).optional(),
}).strict();

const nodeBase = {
  id: z.string().regex(nodeId),
  parentId: z.string().max(80).refine((value) => nodeId.test(value) || nodeHostId.test(value), "Geçersiz üst öğe."),
  order: z.number().int().min(0).max(999),
  desktop: nodeBox,
  frame: nodeFrame.optional(),
  tablet: nodeLayout.optional(),
  mobile: nodeLayout.optional(),
};

const editorNodeSchema = z.discriminatedUnion("type", [
  z.object({
    ...nodeBase,
    type: z.literal("container"),
    style: z.object({
      background: hexColor.optional(),
      borderWidth: z.number().int().min(0).max(20).optional(),
      borderColor: hexColor.optional(),
      radius: z.number().int().min(0).max(400).optional(),
      opacity: z.number().int().min(10).max(100).optional(),
      shadow: editorBoxSchema.shape.shadow,
    }).strict().optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal("text"),
    text: z.string().max(2000),
    style: z.object({
      fontSize: z.number().int().min(8).max(120).optional(),
      color: hexColor.optional(),
      fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      fontFamily: z.enum(["display", "sans", "script"]).optional(),
      lineHeight: z.number().min(0.8).max(3).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal("image"),
    mediaId: mediaId.optional(),
    alt: z.string().max(200).regex(/^[^\n\r]*$/).optional(),
    style: z.object({
      fit: z.enum(["cover", "contain"]).optional(),
      focusX: z.number().int().min(0).max(100).optional(),
      focusY: z.number().int().min(0).max(100).optional(),
      radius: z.number().int().min(0).max(400).optional(),
      borderWidth: z.number().int().min(0).max(20).optional(),
      borderColor: hexColor.optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal("button"),
    text: z.string().min(1).max(120).regex(/^[^\n\r]*$/),
    href: z.string().max(300).refine(isSafeHref, "Bağlantı adresi güvenli değil.").optional(),
    style: z.object({
      background: hexColor.optional(),
      color: hexColor.optional(),
      fontSize: z.number().int().min(8).max(64).optional(),
      fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional(),
      borderWidth: z.number().int().min(0).max(20).optional(),
      borderColor: hexColor.optional(),
      radius: z.number().int().min(0).max(999).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal("icon"),
    icon: z.enum(nodeIcons),
    style: z.object({ color: hexColor.optional() }).strict().optional(),
  }).strict(),
]);

type EditorNodeInput = z.infer<typeof editorNodeSchema>;

function nodeTreeIssue(nodes: EditorNodeInput[], layerIds: Set<string>) {
  if (nodes.length > MAX_NODES) return `En fazla ${MAX_NODES} serbest öğe olabilir.`;
  const byId = new Map<string, EditorNodeInput>();
  for (const node of nodes) {
    if (byId.has(node.id) || layerIds.has(node.id)) return "Serbest öğe kimlikleri benzersiz olmalı.";
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    let depth = 1;
    let parent = node.parentId;
    const seen = new Set([node.id]);
    while (nodeId.test(parent)) {
      const next = byId.get(parent);
      if (!next) return "Serbest öğenin üst öğesi bulunamadı.";
      if (next.type !== "container") return "Serbest öğeler yalnızca konteyner içine yerleştirilebilir.";
      if (seen.has(next.id)) return "Serbest öğe hiyerarşisinde döngü var.";
      seen.add(next.id);
      depth += 1;
      if (depth > MAX_NODE_DEPTH) return `Serbest öğeler en fazla ${MAX_NODE_DEPTH} seviye iç içe olabilir.`;
      parent = next.parentId;
    }
    if (!nodeHostId.test(parent)) return "Serbest öğe bu alana eklenemez.";
  }
  return null;
}

const homeEditorSchema = z.object({
  target: z.literal("home"),
  copies: z.record(z.string().regex(editableTextId), editorCopySchema),
  layers: z.array(editorLayerSchema).max(40),
  nodes: z.array(editorNodeSchema).max(MAX_NODES).optional(),
  links: z.record(z.string().regex(editableLinkId), editorLinkSchema).optional(),
  images: z.record(z.string().max(80), editorImageSchema).optional(),
  boxes: z.record(z.string().regex(editableBoxId), editorBoxSchema).optional(),
}).superRefine((value, context) => {
  if (value.nodes) {
    const issue = nodeTreeIssue(value.nodes, new Set(value.layers.map((layer) => layer.id)));
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["nodes"] });
  }
  if (Object.keys(value.boxes ?? {}).length > 80) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Çok fazla kutu tasarımı değişikliği." });
  }
  const images = Object.entries(value.images ?? {});
  if (images.length > 40) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Çok fazla görsel değişikliği." });
  }
  for (const [id, image] of images) {
    const issue = imageIssue(id, image);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["images", id] });
  }
  if (Object.keys(value.copies).length > 120) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Çok fazla metin değişikliği." });
  }
  const links = Object.keys(value.links ?? {});
  if (links.length > 80) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Çok fazla bağlantı değişikliği." });
  }
  for (const id of links) {
    if (editableTextId.test(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Bir öğe hem metin hem bağlantı olarak kaydedilemez." });
    }
    const card = /^home\.(?:collections|promos)\.card\.[a-z0-9-]+$/.test(id);
    if (card && Object.keys(value.links?.[id] ?? {}).some((key) => key !== "href")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Kart bağlantısında yalnızca adres değiştirilebilir." });
    }
  }
});

export const pageDocumentV2Schema = z.object({
  version: z.literal(2),
  sections: z.array(sectionSchema).max(40),
  editor: homeEditorSchema.optional(),
});

export const pageDocumentSchema = z.discriminatedUnion("version", [pageDocumentV1Schema, pageDocumentV2Schema]);

export type PageDocument = z.infer<typeof pageDocumentSchema>;

export function editorMediaIds(document: PageDocument) {
  if (document.version !== 2 || !document.editor) return [];
  const ids = [
    ...Object.values(document.editor.images ?? {}).map((image) => image.mediaId),
    ...Object.values(document.editor.boxes ?? {}).map((box) => box.backgroundMediaId),
    ...(document.editor.nodes ?? []).map((node) => (node.type === "image" ? node.mediaId : undefined)),
  ];
  return [...new Set(ids.filter((id): id is string => !!id))];
}
export type PageBlock = z.infer<typeof blockSchema>;

export const defaultVisibility = { desktop: true, tablet: true, mobile: true };
export const defaultSpacing = { top: 0, right: 0, bottom: 0, left: 0 };
