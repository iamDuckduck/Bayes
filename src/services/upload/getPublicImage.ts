import type { Context } from "hono";
import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import { getPublicImageById } from "../../repositories/submission/getPublicImage";
import type { AppEnv } from "../../types/app";
import { getOptionalAuthIdentity } from "./helpers";
import { imagesQuerySchema } from "./schemas";
import { resolveImageScope, resolvePublicAssetBaseUrl } from "./scope";

const imageQuerySchema = imagesQuerySchema.pick({ scope: true });

export async function handleGetPublicImage(c: Context<AppEnv, "/images/:id">) {
  c.header("Cache-Control", "private, no-store");
  const parsed = imageQuerySchema.safeParse({ scope: c.req.query("scope") });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const config = getRuntimeConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
  const item = await getPublicImageById(c.env.DB, {
    id: c.req.param("id"),
    assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
    ...scope,
    viewerUserId: identity?.uid
  });
  if (!item) {
    throw new ApiError(404, "NOT_FOUND", "Image not found.");
  }
  return c.json({ item });
}
