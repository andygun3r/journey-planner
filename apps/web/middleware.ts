import { NextRequest, NextResponse } from "next/server";

/**
 * Device identity (no auth): every browser gets a stable `mainline_device`
 * UUID cookie that keys its commutes, holidays, alerts and push subscription.
 *
 * The middleware only *mints and sets* the cookie — it must not touch the
 * database (this runs on the Edge runtime, no pg). The id is also mirrored onto
 * a request header so the very first render, before the cookie round-trips back,
 * can read the freshly-minted value via `lib/device.ts`.
 *
 * The cookie is deliberately NOT httpOnly: the service-worker push registration
 * reads it from `document.cookie` to associate a subscription with the device.
 */

export const DEVICE_COOKIE = "mainline_device";
export const DEVICE_HEADER = "x-mainline-device";

export function middleware(req: NextRequest) {
  const existing = req.cookies.get(DEVICE_COOKIE)?.value;
  const deviceId = existing ?? crypto.randomUUID();

  // Make the id visible to this same request's server components / route handlers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(DEVICE_HEADER, deviceId);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  if (!existing) {
    res.cookies.set(DEVICE_COOKIE, deviceId, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365 * 10, // ~10 years
    });
  }

  return res;
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|.*\\.(?:png|jpg|jpeg|svg|ico|webmanifest)).*)"],
};
