export class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      error: error.name,
      message: error.message,
      details: error.details
    };
  }

  return {
    statusCode: 500,
    error: 'InternalServerError',
    message: 'Erro interno ao processar a mensagem.'
  };
}
