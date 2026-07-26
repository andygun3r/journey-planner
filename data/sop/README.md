# SOP / ECS signalling bit-maps (`data/sop/`)

These files decode Network Rail TD **S-class** signalling data into named signals
and aspects. Each file describes, for one TD area, which signalling item every
`(address, bit)` pair represents. The live ingester stores raw S-class bytes in
`nr_signalling_state`; joining those against `sop_mapping` (loaded from here)
yields per-signal aspects on the signalling diagram.

## Sourcing the data

Network Rail publishes **no single download** for these. They come per TD area
from the Open Rail Data community (SOP tables / ECS specs) and FOI releases:

- Open Rail Data Wiki — <https://wiki.openraildata.com/index.php/List_of_Train_Describers>
  (per-area pages carry SOP/ECS bit maps where documented)
- <https://wiki.openraildata.com/index.php/Decoding_S-Class_Data>

**Not every area is documented** — legacy signalling areas may have no map, in
which case their signals render as "unknown" on the diagram. That is expected.

## File format (JSON — the default loader)

A file is either an array of rows, or `{ "tdArea": "XX", "rows": [ ... ] }`
(so per-row `tdArea` can be omitted). Each row:

| field         | required | notes                                             |
|---------------|----------|---------------------------------------------------|
| `tdArea`      | if not set at file level | TD area id, e.g. `"Q0"`           |
| `address`     | yes      | hex address within the area, e.g. `"0b"`          |
| `bit`         | yes      | bit index 0–7 within that byte                    |
| `itemType`    | yes      | `signal` \| `point` \| `track` \| `route`         |
| `itemId`      | no       | signal number / points id / track id              |
| `aspect`      | no       | for signal bits: what a **set** bit means, e.g. `"off"` (clear) or `"red"` |
| `description` | no       | free text                                         |

Load with: `pnpm --filter @mainline/nr-ingest start sop`
(or point `SOP_DIR` at another directory).

## `Q0.sample.json`

`Q0.sample.json` is **illustrative sample data**, not a real signalling map —
it exists so the pipeline and diagram can be exercised end-to-end. Replace it
with real per-area SOP files before relying on aspects.
