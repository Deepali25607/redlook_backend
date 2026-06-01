# Redlook

E-commerce app split across two workspaces — fully isolated from the
sibling **Freshkart** project on this machine (different DB container,
different ports, different localStorage namespace).

| Component      | Path                 | Dev URL                  | Port |
| -------------- | -------------------- | ------------------------ | ---- |
| Backend (API)  | `redlook_backend/`   | http://localhost:4001    | 4001 |
| Frontend (Web) | `redlook_frontend/`  | http://localhost:5174    | 5174 |
| Postgres (DB)  | docker container     | `localhost:5433`         | 5433 |

> Why these ports: Freshkart binds 4000/5173/5432 on the same machine.
> Redlook is offset by one across the board so both stacks can run side
> by side without collision.

---

## Prerequisites

- Node.js 20+
- Docker Desktop (for the local Postgres container)

## First-time setup

```powershell
# 1. Start Postgres (container `redlook-postgres`, volume `redlook_pgdata`)
cd redlook_backend
docker compose up -d

# 2. Install backend deps + generate Prisma client
npm install
npx prisma generate

# 3. Apply migrations + seed the catalog & admin user
npx prisma migrate deploy
npm run seed

# 4. Install frontend deps
cd ..\redlook_frontend
npm install
```

## Running the dev servers

Open two terminals:

```powershell
# Terminal 1 — API
cd redlook_backend
npm run dev          # node --watch src/index.js  → :4001

# Terminal 2 — Web
cd redlook_frontend
npm run dev          # vite → :5174
```

Open http://localhost:5174 in a browser.

### Default seeded admin

| Field    | Value             |
| -------- | ----------------- |
| Email    | `admin@redlook.com` |
| Password | `Admin@123`       |

Change the password immediately. The seed script never overwrites an
existing admin's `password_hash`, so a rotated password sticks across
re-seeds.

---

## Environment files

- `redlook_backend/.env` — DATABASE_URL, PORT, JWT, CORS_ORIGINS,
  Cloudinary, Razorpay, MSG91. A working dev `.env` is committed
  (gitignore covers production secrets). `.env.example` documents the
  full set.
- `redlook_frontend/.env` — `VITE_USE_MOCK=false` and
  `VITE_API_BASE_URL=http://localhost:4001/api`. Flip `VITE_USE_MOCK` to
  `true` for offline / pre-backend demos (mock layer is in
  `src/api.js`).

## Isolation from Freshkart

The two projects share **no** runtime state on this machine:

| Resource             | Freshkart            | Redlook              |
| -------------------- | -------------------- | -------------------- |
| Docker container     | `freshkart-postgres` | `redlook-postgres`   |
| Docker volume        | `freshkart_pgdata`   | `redlook_pgdata`     |
| Postgres port        | 5432                 | 5433                 |
| API port             | 4000                 | 4001                 |
| Vite dev port        | 5173                 | 5174                 |
| localStorage prefix  | `freshkart_*`        | `redlook_*`          |

Both stacks can run concurrently without touching each other.

## Useful scripts

```powershell
# Backend
npm run dev            # node --watch src/index.js
npm run start          # prisma migrate deploy && node src/index.js
npm run migrate        # prisma migrate dev (interactive — new migrations)
npm run migrate:deploy # prisma migrate deploy (CI / prod)
npm run seed           # idempotent re-seed
npm run studio         # Prisma Studio (DB browser)
npm run generate       # regenerate Prisma client after schema edits

# Frontend
npm run dev            # vite dev server (port 5174, strict)
npm run build          # vite production build → dist/
npm run preview        # serve dist/
npm run lint           # eslint
```

## Stopping & cleaning up

```powershell
cd redlook_backend

# Stop the Postgres container (keeps data in the named volume)
docker compose down

# Wipe the DB completely (irreversible)
docker compose down -v
```


app password
dmrl hicy uvqi xfns

imdeepali14@gmail.com