import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  payloadSchemas,
  handleCreateEvent,
  handleSellTickets,
  handleCheckIn,
  handleAddMobileMoneyAccount,
  handleEditEvent,
  handleCancelEvent,
  handleRefundOrder,
  handleApplyVendor,
  handleAddVendor,
  handleApproveVendor,
  handleRejectVendor,
  handleCheckInVendor,
} from "@/lib/sync-handlers";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED", retry: true }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.type || !body?.payload) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const schema = payloadSchemas[body.type as keyof typeof payloadSchemas];
  if (!schema) {
    return NextResponse.json({ ok: false, reason: "UNKNOWN_OP" }, { status: 400 });
  }
  const validated = schema.safeParse(body.payload);
  if (!validated.success) {
    return NextResponse.json(
      { ok: false, reason: "INVALID_PAYLOAD", details: validated.error.issues[0]?.message },
      { status: 400 }
    );
  }
  body.payload = validated.data;

  try {
    let result;
    switch (body.type) {
      case "CREATE_EVENT":
        result = await handleCreateEvent(session.user.id, body.payload);
        break;
      case "SELL_TICKETS":
        result = await handleSellTickets(session.user.id, body.payload);
        break;
      case "CHECK_IN":
        result = await handleCheckIn(body.payload);
        break;
      case "ADD_MOBILE_MONEY_ACCOUNT":
        result = await handleAddMobileMoneyAccount(session.user.id, body.payload);
        break;
      case "EDIT_EVENT":
        result = await handleEditEvent(session.user.id, body.payload);
        break;
      case "CANCEL_EVENT":
        result = await handleCancelEvent(session.user.id, body.payload);
        break;
      case "REFUND_ORDER":
        result = await handleRefundOrder(session.user.id, body.payload);
        break;
      case "APPLY_VENDOR":
        result = await handleApplyVendor(session.user.id, body.payload);
        break;
      case "ADD_VENDOR":
        result = await handleAddVendor(session.user.id, body.payload);
        break;
      case "APPROVE_VENDOR":
        result = await handleApproveVendor(session.user.id, body.payload);
        break;
      case "REJECT_VENDOR":
        result = await handleRejectVendor(session.user.id, body.payload);
        break;
      case "CHECK_IN_VENDOR":
        result = await handleCheckInVendor(body.payload);
        break;
      default:
        return NextResponse.json({ ok: false, reason: "UNKNOWN_OP" }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("sync/push error", err);
    return NextResponse.json({ ok: false, reason: "SERVER_ERROR", retry: true }, { status: 500 });
  }
}
