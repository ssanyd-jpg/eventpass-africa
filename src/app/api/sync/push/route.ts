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
  handleAddSponsor,
  handleApproveVendor,
  handleRejectVendor,
  handleCheckInVendor,
  handleCreateWallet,
  handleCarryOverWallet,
  handleRecordChipTime,
  handleProvisionCredential,
  handleReplaceCredential,
  handleTopupWallet,
  handleCheckTopupStatus,
  handleCheckOrderPaymentStatus,
  handleCancelPendingOrder,
  handleMarkOrderPaid,
  handleChargeWallet,
  handleSplitPayment,
  handleWithdrawWallet,
  handleApproveWithdrawal,
  handleRejectWithdrawal,
  handleSponsorTap,
  handleAddSponsorCampaign,
  handleDeactivateSponsorCampaign,
} from "@/lib/sync-handlers";
import { isOpAllowedForRole } from "@/lib/access-control";
import { logAudit, buildSyncAuditEntry } from "@/lib/audit";
import { checkAndTrackDevice } from "@/lib/device-handlers";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED", retry: true }, { status: 401 });
  }

  // Absent header = an already-installed PWA client running JS cached from
  // before this device check shipped (next-pwa runtime-caches page/API
  // responses) — skip tracking/enforcement entirely rather than lock it out.
  const deviceId = request.headers.get("X-Device-Id");
  if (deviceId) {
    const deviceCheck = await checkAndTrackDevice(
      session.user.organizationId,
      deviceId,
      session.user.id,
      session.user.name ?? session.user.email ?? "Unknown"
    );
    if (!deviceCheck.ok) {
      return NextResponse.json({ ok: false, reason: deviceCheck.reason }, { status: 403 });
    }
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

  if (!isOpAllowedForRole(session.user.organizationRole, body.type as keyof typeof payloadSchemas)) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  try {
    let result;
    switch (body.type) {
      case "CREATE_EVENT":
        result = await handleCreateEvent(session.user.id, session.user.organizationId, body.payload);
        break;
      case "SELL_TICKETS":
        result = await handleSellTickets(session.user.id, body.payload);
        break;
      case "CHECK_IN":
        result = await handleCheckIn(session.user.id, session.user.organizationId, body.payload);
        break;
      case "ADD_MOBILE_MONEY_ACCOUNT":
        result = await handleAddMobileMoneyAccount(session.user.id, session.user.organizationId, body.payload);
        break;
      case "EDIT_EVENT":
        result = await handleEditEvent(session.user.id, session.user.organizationId, body.payload);
        break;
      case "CANCEL_EVENT":
        result = await handleCancelEvent(session.user.id, session.user.organizationId, body.payload);
        break;
      case "REFUND_ORDER":
        result = await handleRefundOrder(session.user.id, session.user.organizationId, body.payload);
        break;
      case "APPLY_VENDOR":
        result = await handleApplyVendor(session.user.id, body.payload);
        break;
      case "ADD_VENDOR":
        result = await handleAddVendor(session.user.id, session.user.organizationId, body.payload);
        break;
      case "ADD_SPONSOR":
        result = await handleAddSponsor(session.user.id, session.user.organizationId, body.payload);
        break;
      case "APPROVE_VENDOR":
        result = await handleApproveVendor(session.user.id, session.user.organizationId, body.payload);
        break;
      case "REJECT_VENDOR":
        result = await handleRejectVendor(session.user.id, session.user.organizationId, body.payload);
        break;
      case "CHECK_IN_VENDOR":
        result = await handleCheckInVendor(session.user.id, session.user.organizationId, body.payload);
        break;
      case "CREATE_WALLET":
        result = await handleCreateWallet(session.user.id, body.payload);
        break;
      case "CARRY_OVER_WALLET":
        result = await handleCarryOverWallet(session.user.id, body.payload);
        break;
      case "RECORD_CHIP_TIME":
        result = await handleRecordChipTime(session.user.organizationId, body.payload);
        break;
      case "PROVISION_CREDENTIAL":
        result = await handleProvisionCredential(session.user.id, session.user.organizationId, body.payload);
        break;
      case "REPLACE_CREDENTIAL":
        result = await handleReplaceCredential(session.user.id, session.user.organizationId, body.payload);
        break;
      case "TOPUP_WALLET":
        result = await handleTopupWallet(session.user.id, body.payload);
        break;
      case "CHECK_TOPUP_STATUS":
        result = await handleCheckTopupStatus(body.payload);
        break;
      case "CHECK_ORDER_PAYMENT_STATUS":
        result = await handleCheckOrderPaymentStatus(body.payload);
        break;
      case "CANCEL_PENDING_ORDER":
        result = await handleCancelPendingOrder(session.user.id, body.payload);
        break;
      case "MARK_ORDER_PAID":
        result = await handleMarkOrderPaid(session.user.id, session.user.organizationId, body.payload);
        break;
      case "CHARGE_WALLET":
        result = await handleChargeWallet(session.user.id, session.user.organizationId, body.payload);
        break;
      case "SPLIT_PAYMENT":
        result = await handleSplitPayment(session.user.id, session.user.organizationId, body.payload);
        break;
      case "WITHDRAW_WALLET":
        result = await handleWithdrawWallet(session.user.id, body.payload);
        break;
      case "APPROVE_WITHDRAWAL":
        result = await handleApproveWithdrawal(session.user.id, session.user.organizationId, body.payload);
        break;
      case "REJECT_WITHDRAWAL":
        result = await handleRejectWithdrawal(session.user.id, session.user.organizationId, body.payload);
        break;
      case "SPONSOR_TAP":
        result = await handleSponsorTap(session.user.id, session.user.organizationId, body.payload);
        break;
      case "ADD_SPONSOR_CAMPAIGN":
        result = await handleAddSponsorCampaign(session.user.id, session.user.organizationId, body.payload);
        break;
      case "DEACTIVATE_SPONSOR_CAMPAIGN":
        result = await handleDeactivateSponsorCampaign(session.user.id, session.user.organizationId, body.payload);
        break;
      default:
        return NextResponse.json({ ok: false, reason: "UNKNOWN_OP" }, { status: 400 });
    }

    const auditEntry = buildSyncAuditEntry(body.type, result);
    if (auditEntry) {
      await logAudit({
        organizationId: session.user.organizationId,
        actorUserId: session.user.id,
        actorName: session.user.name ?? session.user.email ?? "Unknown",
        ...auditEntry,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("sync/push error", err);
    return NextResponse.json({ ok: false, reason: "SERVER_ERROR", retry: true }, { status: 500 });
  }
}
