/**
 * Re-exports the RDG National Rail Disruptions client from @signaller/shared,
 * where it moved so services/darwin-ingest can also use it (matching
 * disruptions to commutes for push alerts). Keep importing from here in
 * apps/web — this file is just the seam, not a second implementation.
 */
export {
  disruptionsConfigured,
  fetchStationDisruptions,
  fetchServiceIndicators,
  serviceIndicatorsByToc,
  serviceIndicatorsByRegion,
  fetchNetworkDisruptions,
  RTPPM_TO_DISRUPTIONS_NAME,
  type Inline,
  type DisruptionBlock,
  type Disruption,
  type ServiceIndicator,
} from "@signaller/shared";
