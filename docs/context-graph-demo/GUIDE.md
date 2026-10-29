# Context Graph demo: from a PIM to the graph with n8n

This guide builds the **Tonevik** demo shop in an Enterspeed Context Graph,
one step at a time, with the **Enterspeed Context Graph** n8n node. Each step
adds one thing, teaches one idea, and ends with a check that it worked.

Tonevik is a small fictional shop for audio gear. Its data and schema come
from the Context Graph SDK (semantic-graph-sdk › packages › dev-server ›
examples › tonevik). This guide covers only the n8n side; for what the graph
does with the data (models, shapes, indexes, routes), read the SDK's
*Getting Started* guide alongside it.

## What you'll build

```
                        ┌─ Step 1 · Get PIM categories ─ Step 1 · Collect categories ─ Step 1 · Push categories
When clicking           │
'Execute workflow' ─────┼─ Step 2 · Get PIM products ─── Step 2 · Collect products ─── Step 2 · Push products
                        │
                        └─ Step 3 · Get PIM deletes ──── Step 3 · Collect deletes ──── Step 3 · Push deletes
```

| Step | What you add | What it teaches | Expect |
|---|---|---|---|
| 0 | The dev-server, n8n and the workflow | Setting up | The Tonevik schema is served |
| 1 | The PIM's categories | **The record**: what a Context Graph record is, and why Push Many sends it as it is | 4 results, accepted |
| 2 | The PIM's products | Records linking up in the graph: a product finds its category | 12 results, accepted |
| 3 | A retired product | Deleting a record by its key | 1 delete, accepted |

The workflow reads left to right in the order the data travels: a **Get**
node stands in for the source system, an **Aggregate** node collects its
records into one list, and a **Push** node sends that list to the graph
with *Entity › Push Many*, in one request. Each step's check is the Push
node's output, one result per record. Reading the data back out of the graph in n8n, and a second
source system, are later steps that will be added as the node grows.

## Step 0 · Set up

You need Docker, Node.js and a checkout of semantic-graph-sdk.

1. **Start the Tonevik dev-server.** From semantic-graph-sdk's
   `packages/dev-server/examples` folder:

   ```bash
   npx tsx tonevik/solutions/1-shop.ts
   ```

   It listens on `http://localhost:5200`. Use this file, **not**
   `start-demo.ts`: that is a different schema with a `commerce` source, and
   none of Tonevik's `pim` records would show up in it.

2. **Start n8n with this package.** In this repo:

   ```bash
   npm run build
   docker compose up -d
   node scripts/setup.mjs
   ```

   `setup.mjs` creates an *Enterspeed Context Graph account* credential
   pointing at the dev-server (`http://host.docker.internal:5200`, as n8n
   sees it from inside Docker) and imports the workflow
   **Context Graph: Tonevik demo**. It reads `.env` and needs the keys
   listed in `.env.example`.

   If you import the workflow through n8n's UI instead, its credential
   can't be filled in for you: open each **Push** node and select
   *Enterspeed Context Graph account*, or the step fails with the
   credential not set.

3. **Check.** Open `http://localhost:5200/schema/docs/v1/1.0.0` in a
   browser. It shows the schema the dev-server runs, which should have the
   `pim` source with `category` and `product`. If it shows a `commerce`
   source, you started `start-demo.ts`.

Open n8n at `http://localhost:5678` and open the workflow. Run one step at a
time: open the step's **Push** node and click **Execute step**. That runs
the step's **Get**, **Collect** and **Push** nodes only. (*Execute workflow*
runs all three steps at once.)

## Step 1 · Categories: the record

**Run:** *Step 1 · Push categories*.

*Step 1 · Get PIM categories* returns the PIM's four categories, exactly as
the PIM delivers them:

```json
{ "$id": "pim-cat-dd34d4", "$type": "category", "$source": "pim", "id": "cat-speakers", "name": "Speakers" }
```

This is a **Context Graph record**. The `$` fields tell the graph what the
record is; everything else is the record's own data:

| Field | What it is |
|---|---|
| `$id` | The **source system's own key** for the record. It identifies the entity and stays the same every time the record is sent, so sending it again updates the entity instead of adding a second one. |
| `$type` | The entity type. |
| `$source` | The source the record came from. |
| `$action` | `delete` removes the entity; anything else, or nothing, saves it. |
| `$modifiedAt` | When the record last changed in the source (not in this data yet). |
| anything else | The entity's own fields, stored exactly as sent. |

Note that `$id` (`pim-cat-dd34d4`) and `id` (`cat-speakers`) are **two
different things**. `$id` is how the PIM files the record; `id` is the
category's own identity, the one the schema's models and other records use
to find it. The graph keeps both. Never set `$id` from `id`: that cuts the
link back to the PIM record the entity came from.

*Step 1 · Collect categories* is an **Aggregate** node (*All Item Data*).
It turns the four records into one item holding them as a list:

```json
{ "data": [ { "$id": "pim-cat-26474b", … }, { "$id": "pim-cat-e8da45", … }, … ] }
```

**Push Many** reads that list from its *Records* field (`{{ $json.data }}`)
and sends every record in one request, exactly as it is. Each record carries
its own `$` fields, so there is nothing to set. n8n is only the
integration; it never reshapes the data.

**Expect** four results, one per record in the list:

```json
{ "id": "pim-cat-dd34d4", "type": "category", "source": "pim", "action": "upsert", "accepted": true, "statusCode": 200 }
```

In the graph, the schema finds the category by its own `id`
(`cat-speakers`), not its `$id`: the graph works with the record's data,
while `$id` keeps track of where it came from.

## Step 2 · Products: records link up

**Run:** *Step 2 · Push products*.

*Step 2 · Get PIM products* returns the PIM's twelve products. Each names its
category in its own data:

```json
{ "$id": "pim-prd-5ce6b5", "$type": "product", "$source": "pim", "id": "p-1001", "sku": "AUR-HP-100", "name": "Aurora H100 Over-Ear Headphones", "categoryId": "cat-headphones", "price": 2700, "inStock": true }
```

*Step 2 · Collect products* collects them into one list, and Push Many
sends the twelve in one request, the same way as the categories. Nothing in n8n joins a
product to its category: the schema declares that `categoryId` points at a
category, and the graph makes the link from the pushed data.

**Expect** twelve results, all `accepted: true`.

The schema now has what it needs for a product page: `/products/p-1001`
shows the product together with its category, *Headphones*, found through
`categoryId`. Reading it back in n8n is a later step.

## Step 3 · A retired product: deleting

**Run:** *Step 3 · Push deletes*.

The PIM retires *Vega Band Kids*. *Step 3 · Get PIM deletes* returns the
record the PIM sends for that:

```json
{ "$id": "pim-prd-2005f2", "$type": "product", "$source": "pim", "$action": "delete" }
```

A delete names the record by its `$id` (`pim-prd-2005f2`), not by its own
`id` (`p-1010`), which is one more reason `$id` must stay the source's key.
Push Many sees the record's own `$action: "delete"` and sends a delete. A
delete carries no other fields.

**Expect** one result with `action: "delete"` and `accepted: true`. The
product is gone from the graph; the other products are still there.

## When your source doesn't send Context Graph records

Tonevik's PIM already delivers Context Graph records. Most real sources
don't. Push Many sends each record as it is, so fit the records in a
**Code** or **Edit Fields** node before the Aggregate node, where you can
see it in the workflow:

```js
// Fit each source record to a Context Graph record.
return $input.all().map(({ json }) => ({
  json: {
    ...json,                      // the record's own fields, stored as they are
    $id: json.recordKey,          // the source system's own record key
    $type: 'category',            // the entity type
    $source: 'pim',               // the source the record belongs to
    ...(json.deleted === true && { $action: 'delete' }),    // remove instead of save
    ...(json.updatedAt && { $modifiedAt: json.updatedAt }), // when it changed in the source
  },
}));
```

Whichever you use, `$id` must be the source system's own key for the record,
the same every time it's sent.

## Reference

- **Push and Push Many:** the *Context Graph* section of the package README.
- **The rules behind the record:** the Context Graph's *Ingest NDJSON*
  contract (semantic-graph › contracts › spec) and its ingest ADRs
  (semantic-graph › contracts › docs › adr › ingest).
