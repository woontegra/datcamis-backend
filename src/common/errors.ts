export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(message = "Kayıt bulunamadı.") {
  return new AppError(404, "NOT_FOUND", message);
}
