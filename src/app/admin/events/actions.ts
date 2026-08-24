"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

export async function adminSetEventStatus(eventId: string, status: "LIVE" | "CANCELLED") {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") throw new Error("Forbidden");

  const event = await prisma.event.update({ where: { id: eventId }, data: { status } });

  if (status === "CANCELLED") {
    const affectedOrders = await prisma.order.findMany({
      where: { eventId, status: { in: ["PAID", "NEEDS_REVIEW"] } },
      include: { user: { select: { email: true, name: true } } },
      distinct: ["userId"],
    });
    for (const o of affectedOrders) {
      await sendNotification({
        type: "EVENT_CANCELLED",
        channel: "EMAIL",
        recipient: o.user.email,
        subject: `${event.title} has been cancelled`,
        body: `Hi ${o.user.name}, ${event.title} has been removed by a platform moderator. Please contact support about a refund.`,
      });
    }
  }

  revalidatePath("/admin/events");
}
