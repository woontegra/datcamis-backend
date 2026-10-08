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

export const pageDocumentSchema = z.object({
  version: z.literal(1),
  sections: z.array(sectionSchema).max(40),
});

export type PageDocument = z.infer<typeof pageDocumentSchema>;
export type PageBlock = z.infer<typeof blockSchema>;

export const defaultVisibility = { desktop: true, tablet: true, mobile: true };
export const defaultSpacing = { top: 0, right: 0, bottom: 0, left: 0 };
