"use client";

import { useState, useTransition } from "react";
import { sendTestAlertAction } from "@/app/admin/actions";

/**
 * Sends a test push to the admin's own device. The point is to tell apart the
 * three things that look identical when push "doesn't work": no VAPID keys on
 * the server, no subscription on the account, or a subscription the push
 * service has since expired.
 */
export function AdminTestAlert({ sendConfigured }: { sendConfigured: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function send() {
    setError(null);
    setSent(false);
    startTransition(async () => {
      const result = await sendTestAlertAction();
      if (result.ok) setSent(true);
      else setError(result.error);
    });
  }

  if (!sendConfigured) {
    return (
      <p className="push-note">
        This server can&rsquo;t send push notifications — VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
        both need to be set in its environment.
      </p>
    );
  }

  return (
    <div>
      <button type="button" className="btn btn-secondary" onClick={send} disabled={pending}>
        {pending ? "Sending…" : "Send a test alert to my device"}
      </button>
      {sent && (
        <p className="push-note" role="status">
          Sent. It should arrive within a few seconds.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
