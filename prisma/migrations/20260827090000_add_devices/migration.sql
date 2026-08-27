-- Device registry: purely additive, new table + one FK, no existing data touched.

CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenByUserId" TEXT NOT NULL,
    "lastSeenByName" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Device_organizationId_deviceId_key" ON "Device"("organizationId", "deviceId");

ALTER TABLE "Device" ADD CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
