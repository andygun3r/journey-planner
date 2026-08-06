import stompit from "stompit";

/**
 * Network Rail Open Data STOMP connection.
 *
 * AUTH: there is NO API key — you use your datafeeds.networkrail.co.uk account
 * email as the STOMP login and your account password as the passcode. You must
 * also have SUBSCRIBED to each feed/topic on the "My Feeds" page, or the broker
 * authenticates but returns "not authorized to read from topic".
 *
 * Broker (as published by Network Rail): publicdatafeeds.networkrail.co.uk:61618
 */

export interface NrConnectConfig {
  host: string;
  port: number;
  login: string;
  passcode: string;
  clientId: string;
}

export function nrConfig(): NrConnectConfig {
  const login = process.env.NETWORKRAIL_USERNAME;
  const passcode = process.env.NETWORKRAIL_PASSWORD;
  if (!login || !passcode) {
    throw new Error(
      "NETWORKRAIL_USERNAME / NETWORKRAIL_PASSWORD not set — use your datafeeds.networkrail.co.uk account email + password.",
    );
  }
  return {
    host: process.env.NR_STOMP_HOST ?? "publicdatafeeds.networkrail.co.uk",
    port: Number(process.env.NR_STOMP_PORT ?? "61618"),
    login,
    passcode,
    // Durable-subscription client id; keep stable so we resume, not restart.
    clientId: process.env.NR_CLIENT_ID ?? `signaller-nr-${login}`,
  };
}

export function connect(cfg: NrConnectConfig): Promise<stompit.Client> {
  return new Promise((resolve, reject) => {
    stompit.connect(
      {
        host: cfg.host,
        port: cfg.port,
        // client-id + heart-beat are valid STOMP headers @types/stompit omits.
        connectHeaders: {
          host: "/",
          login: cfg.login,
          passcode: cfg.passcode,
          "client-id": cfg.clientId,
          "heart-beat": "15000,15000",
        } as unknown as Record<string, string>,
      },
      (err, client) => (err ? reject(err) : resolve(client)),
    );
  });
}

/** Topic names (subscribe to these on the My Feeds page first). */
export const TOPICS = {
  trainMovements: "/topic/TRAIN_MVT_ALL_TOC",
  trainDescriber: "/topic/TD_ALL_SIG_AREA",
  vstp: "/topic/VSTP_ALL",
  tsr: "/topic/TSR_ALL_ROUTE",
  rtppm: "/topic/RTPPM_ALL",
} as const;
