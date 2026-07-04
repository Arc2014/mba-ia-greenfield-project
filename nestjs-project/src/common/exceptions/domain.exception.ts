export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video does not belong to your channel');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super('UPLOAD_ALREADY_COMPLETED', 409, 'Upload is not in a draft state');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super('INVALID_UPLOAD_PARTS', 400, 'Upload parts are missing or invalid');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 413, 'File exceeds the maximum allowed size');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type');
  }
}
