import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Populates `request.user` when a valid Bearer token is present, but never
 * rejects. Pair it with `@Public()` (which skips the global guard) on routes
 * that are open to anonymous callers yet behave differently for the owner —
 * e.g. `GET /videos/:publicId`, where the owner may see non-READY videos.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token on an optional route → treat as anonymous.
      }
    }

    return true;
  }
}
