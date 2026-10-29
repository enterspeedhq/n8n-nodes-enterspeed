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
                        ┌─ Step 1 · Get PIM categories ─ Collect categories ─ Push categories ─ Shape keys ─ Read back
When clicking           │
'Execute workflow' ─────┼─ Step 2 · Get PIM products ─── Collect products ─── Push products ─── Shape keys ─ Read back
                        │
                        └─ Step 3 · Get PIM deletes ──── Collect deletes ──── Push deletes ──── Shape keys ─ Read back
```

(Every node's name starts with its step, e.g. *Step 1 · Shape keys*.)

| Step | What you add | What it teaches | Expect |
|---|---|---|---|
| 0 | The dev-server, n8n and the workflow | Setting up | The Tonevik schema is served |
| 1 | The PIM's categories | **The record**: what a Context Graph record is, and why Push Many sends it as it is. **Shapes**: reading back what the graph made of it | 4 results, accepted; 4 `CategoryRef` shapes |
| 2 | The PIM's products | Records linking up in the graph: a product finds its category. Reading many shapes, and when to read one | 12 results, accepted; 12 `ProductCard` shapes |
| 3 | A retired product | Deleting a record by its key | 1 delete, accepted; its shape is gone |

The workflow reads left to right in the order the data travels: a **Get**
node stands in for the source system, an **Aggregate** node collects its
records into one list, and a **Push** node sends that list to the graph
with *Entity › Push Many*, in one request. A **Code** node then lists the
shape keys to check, and a **Read back** node reads what the graph made of
the records with *Shape › Get Many*, also in one request. Each step has two
checks: the Push node's output, one result per record, and the Read back
node's output, the graph's shapes for those records. A second source
system is a later step that will be added as the node grows.

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
time, in order: open the step's **Read back** node and click **Execute
step**. That runs the step's own nodes only, from its **Get** node to its
**Read back** node. (*Execute workflow* runs all three steps at once.)

## Step 1 · Categories: the record

**Run:** *Step 1 · Read back*.

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

**Expect** four results from *Step 1 · Push categories*, one per record in
the list:

```json
{ "id": "pim-cat-dd34d4", "type": "category", "source": "pim", "action": "upsert", "accepted": true, "statusCode": 200 }
```

In the graph, the schema finds the category by its own `id`
(`cat-speakers`), not its `$id`: the graph works with the record's data,
while `$id` keeps track of where it came from.

### What the graph made of it: shapes

The graph doesn't hand records back as they were sent. The schema declares
**shapes**: views of its data, each with a name and the fields it shows.
Tonevik's `CategoryRef` shape shows a category's `name`.

You read a shape by its **shape key**: the shape's name, then the name and
value of each part of the ID it's found by, joined with colons:

```
CategoryRef:categoryId:cat-speakers
```

The value is the category's own `id`, `cat-speakers`, not the PIM's key
`pim-cat-dd34d4`. That's the point made above: the graph works with the
record's data.

*Step 1 · Shape keys* is a **Code** node. It builds one key per category,
from the category's `id` in *Step 1 · Get PIM categories*, and returns them
as one item holding the list:

```js
const records = $('Step 1 · Get PIM categories').all();
return [{ json: { keys: records.map(({ json }) => `CategoryRef:categoryId:${json.id}`) } }];
```

*Step 1 · Read back* is the node's **Shape › Get Many**. It reads that list
from its *Shape Keys* field (`{{ $json.keys }}`) and reads all four shapes
in one request. **Expect** four items, each with the key, its status and the
shape:

```json
{ "key": "CategoryRef:categoryId:cat-speakers", "status": 200, "data": { "id": "categorymodel:cat-speakers", "name": "Speakers" } }
```

## Step 2 · Products: records link up

**Run:** *Step 2 · Read back*.

*Step 2 · Get PIM products* returns the PIM's twelve products. Each names its
category in its own data:

```json
{ "$id": "pim-prd-5ce6b5", "$type": "product", "$source": "pim", "id": "p-1001", "sku": "AUR-HP-100", "name": "Aurora H100 Over-Ear Headphones", "categoryId": "cat-headphones", "price": 2700, "inStock": true }
```

*Step 2 · Collect products* collects them into one list, and Push Many
sends the twelve in one request, the same way as the categories. Nothing in n8n joins a
product to its category: the schema declares that `categoryId` points at a
category, and the graph makes the link from the pushed data.

**Expect** twelve results from *Step 2 · Push products*, all
`accepted: true`.

*Step 2 · Shape keys* lists every product's `ProductCard` key,
`ProductCard:productId:<the product's id>`, and *Step 2 · Read back* reads
them with **Shape › Get Many**: twelve keys, one request. **Expect** twelve
items with `status: 200`, e.g. for `p-1001`:

```json
{ "key": "ProductCard:productId:p-1001", "status": 200, "data": { "categoryId": "cat-headphones", "id": "productmodel:p-1001", "name": "Aurora H100 Over-Ear Headphones", "price": 2700 } }
```

The answer is the same whether every key is found or none is, so check each
item's `status`, for example with an **If** node on `{{ $json.status }}`.

The node also has **Shape › Get**, which takes one key per item, reads one
key per request and outputs the shape on its own, failing when there is
none (*No shape for key …*). Use it when the workflow really handles one key
at a time, such as a lookup triggered by a webhook. For a list of keys, use
*Get Many*: one request instead of one per key.

The schema now has what it needs for a product page: `/products/p-1001`
shows the product together with its category, *Headphones*, found through
`categoryId`. Reading that page in n8n is a later step.

## Step 3 · A retired product: deleting

**Run:** *Step 3 · Read back*.

The PIM retires *Vega Band Kids*. *Step 3 · Get PIM deletes* returns the
record the PIM sends for that:

```json
{ "$id": "pim-prd-2005f2", "$type": "product", "$source": "pim", "$action": "delete" }
```

A delete names the record by its `$id` (`pim-prd-2005f2`), not by its own
`id` (`p-1010`), which is one more reason `$id` must stay the source's key.
Push Many sees the record's own `$action: "delete"` and sends a delete. A
delete carries no other fields.

**Expect** one result from *Step 3 · Push deletes*, with `action: "delete"`
and `accepted: true`.

*Step 3 · Shape keys* lists two shape keys: the retired product's (`p-1010`)
and one the PIM still sells (`p-1001`). *Step 3 · Read back* reads both with
**Shape › Get Many**. **Expect** the retired product to be gone and the
other still there:

```json
{ "key": "ProductCard:productId:p-1010", "status": 404, "data": null }
{ "key": "ProductCard:productId:p-1001", "status": 200, "data": { "categoryId": "cat-headphones", "id": "productmodel:p-1001", "name": "Aurora H100 Over-Ear Headphones", "price": 2700 } }
```

A key with no shape comes back as `status: 404` with `data: null`, and the
other keys still return. The delete named the record by its `$id`; the
shape key names the product by its own `id`.

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

- **Push, Push Many, Get and Get Many:** the *Context Graph* section of the
  package README.
- **The rules behind the record:** the Context Graph's *Ingest NDJSON*
  contract (semantic-graph › contracts › spec) and its ingest ADRs
  (semantic-graph › contracts › docs › adr › ingest).
