import { ZodError, type ZodTypeAny, z } from "zod";
import { AppError } from "./errors";

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Gönderilen veri geçersiz.", flatten(result.error));
  }
  return result.data;
}

function flatten(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
