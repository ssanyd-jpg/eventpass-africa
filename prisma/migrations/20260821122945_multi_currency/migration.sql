-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LIVE',
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "organizerId" TEXT NOT NULL,
    CONSTRAINT "Event_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("category", "city", "clientId", "createdAt", "description", "id", "imageUrl", "organizerId", "slug", "startsAt", "status", "title", "updatedAt", "venue") SELECT "category", "city", "clientId", "createdAt", "description", "id", "imageUrl", "organizerId", "slug", "startsAt", "status", "title", "updatedAt", "venue" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_clientId_key" ON "Event"("clientId");
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("clientId", "createdAt", "eventId", "id", "status", "totalCents", "updatedAt", "userId") SELECT "clientId", "createdAt", "eventId", "id", "status", "totalCents", "updatedAt", "userId" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_clientId_key" ON "Order"("clientId");
CREATE TABLE "new_Settlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "grossCents" INTEGER NOT NULL,
    "platformFeeCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payoutReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "organizerId" TEXT NOT NULL,
    "mobileMoneyAccountId" TEXT NOT NULL,
    CONSTRAINT "Settlement_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Settlement_mobileMoneyAccountId_fkey" FOREIGN KEY ("mobileMoneyAccountId") REFERENCES "MobileMoneyAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Settlement" ("createdAt", "grossCents", "id", "mobileMoneyAccountId", "netCents", "organizerId", "paidAt", "payoutReference", "periodEnd", "periodStart", "platformFeeCents", "status") SELECT "createdAt", "grossCents", "id", "mobileMoneyAccountId", "netCents", "organizerId", "paidAt", "payoutReference", "periodEnd", "periodStart", "platformFeeCents", "status" FROM "Settlement";
DROP TABLE "Settlement";
ALTER TABLE "new_Settlement" RENAME TO "Settlement";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
