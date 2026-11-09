import {
  ExtractJwt,
  Strategy as JwtStrategy,
  VerifiedCallback
} from 'passport-jwt';
import {
  ACCESS_TOKEN_ALGORITHMS,
  getAccessTokenClaimsOrNull
} from '@/api/auth/access-token-wallet';

/**
 * Passport strategy for Bearer access tokens. A token whose signature verifies
 * but whose claims are not those of an access token fails authentication, so
 * required-auth routes answer 401 and optional-auth routes treat the caller
 * as anonymous.
 */
export function createAccessTokenStrategy(secretOrKey: string): JwtStrategy {
  return new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey,
      algorithms: ACCESS_TOKEN_ALGORITHMS
    },
    (payload: unknown, cb: VerifiedCallback) => {
      const claims = getAccessTokenClaimsOrNull(payload);
      if (!claims) {
        return cb(null, false);
      }
      return cb(null, claims);
    }
  );
}
