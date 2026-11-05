export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status:
      | 400
      | 401
      | 403
      | 404
      | 409
      | 413
      | 415
      | 422
      | 429
      | 500
      | 503
      | 504 = 422,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
