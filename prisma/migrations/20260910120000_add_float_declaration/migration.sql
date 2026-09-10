-- Session 9: end-of-event cash float reconciliation.

CREATE TABLE "FloatDeclaration" (
    "id" TEXT NOT NULL,
    "declaredAmountCents" INTEGER NOT NULL,
    "varianceCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "declaredByUserId" TEXT NOT NULL,

    CONSTRAINT "FloatDeclaration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloatDeclaration_eventId_operatorId_key" ON "FloatDeclaration"("eventId", "operatorId");

ALTER TABLE "FloatDeclaration" ADD CONSTRAINT "FloatDeclaration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FloatDeclaration" ADD CONSTRAINT "FloatDeclaration_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FloatDeclaration" ADD CONSTRAINT "FloatDeclaration_declaredByUserId_fkey" FOREIGN KEY ("declaredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
