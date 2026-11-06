import { randomBytes, timingSafeEqual } from 'node:crypto';
export const sessionCookie = 'inbyeol_session';
export const sessionTtl = 8 * 60 * 60;
function equal(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class BrowserSessions {
  private readonly sessions = new Map<string, number>();
  constructor(
    private readonly token: string,
    private readonly clock = () => Date.now(),
  ) {}
  verifyToken(value: string) {
    return !!this.token && equal(value, this.token);
  }
  authenticate(
    authorization: string | undefined,
    cookie: string | undefined,
  ): 'none' | 'bearer' | 'session' | null {
    if (!this.token) return 'none';
    if (
      authorization?.startsWith('Bearer ') &&
      this.verifyToken(authorization.slice(7))
    )
      return 'bearer';
    const deadline = cookie ? this.sessions.get(cookie) : undefined;
    if (cookie && deadline && deadline > this.clock()) return 'session';
    if (cookie) this.sessions.delete(cookie);
    return null;
  }
  create() {
    for (const [id, deadline] of this.sessions)
      if (deadline <= this.clock()) this.sessions.delete(id);
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value!);
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, this.clock() + sessionTtl * 1000);
    return id;
  }
  delete(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }
}
