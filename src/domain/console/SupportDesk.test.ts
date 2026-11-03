import { describe, expect, it } from "vitest";
import {
  SupportTicket,
  addSupportMinutes,
  checkEscalationLink,
  checkSlaTarget,
  renderCanned,
  supportMinutesBetween,
  type SlaTargets,
} from "./SupportDesk.js";

const targets: SlaTargets = {
  urgent: {
    priority: "urgent",
    firstResponseMinutes: 30,
    resolutionMinutes: 480,
    businessHours: false,
  },
  high: {
    priority: "high",
    firstResponseMinutes: 120,
    resolutionMinutes: 600,
    businessHours: true,
  },
  normal: {
    priority: "normal",
    firstResponseMinutes: 600,
    resolutionMinutes: 3_000,
    businessHours: true,
  },
  low: {
    priority: "low",
    firstResponseMinutes: 1_200,
    resolutionMinutes: 6_000,
    businessHours: true,
  },
};

// Tuesday 3 November 2026, 10:00 in Accra (UTC).
const tuesday10 = new Date("2026-11-03T10:00:00Z");
const at = (iso: string) => new Date(iso);

const raise = (priority: keyof SlaTargets = "normal", now = tuesday10) =>
  SupportTicket.raise(
    {
      id: "00000000-0000-4000-8000-000000000001",
      number: "AF-SUP-2026-000001",
      tenantId: null,
      tenantUserId: null,
      requesterName: "Ama Owusu",
      requesterEmail: "ama@example.com",
      requesterPhone: null,
      channel: "email",
      subject: "Cannot add a vehicle",
      category: "how_to",
      priority,
      createdBy: null,
    },
    targets,
    now,
  );

describe("support hours", () => {
  it("counts only Monday to Saturday 08:00–18:00", () => {
    expect(addSupportMinutes(tuesday10, 60)).toEqual(at("2026-11-03T11:00:00Z"));
    // 10 hours from 10:00 Tuesday: 8 h Tuesday, 2 h Wednesday from 08:00.
    expect(addSupportMinutes(tuesday10, 600)).toEqual(at("2026-11-04T10:00:00Z"));
    // Saturday 17:00 + 2 h: 1 h Saturday, Sunday closed, 1 h Monday.
    expect(addSupportMinutes(at("2026-11-07T17:00:00Z"), 120)).toEqual(at("2026-11-09T09:00:00Z"));
    // Raised at night: the clock starts at the next opening.
    expect(addSupportMinutes(at("2026-11-03T22:00:00Z"), 30)).toEqual(at("2026-11-04T08:30:00Z"));
  });

  it("measures the support minutes between two times", () => {
    expect(supportMinutesBetween(tuesday10, at("2026-11-03T12:30:00Z"))).toBe(150);
    expect(supportMinutesBetween(at("2026-11-07T17:00:00Z"), at("2026-11-09T09:00:00Z"))).toBe(120);
    expect(supportMinutesBetween(at("2026-11-08T09:00:00Z"), at("2026-11-08T17:00:00Z"))).toBe(0);
  });
});

describe("SLA targets", () => {
  it("are whole minutes with resolution no sooner than the first response", () => {
    expect(() => checkSlaTarget({ ...targets.normal, firstResponseMinutes: 2 })).toThrow(
      /5 minutes/,
    );
    expect(() =>
      checkSlaTarget({ ...targets.normal, firstResponseMinutes: 600, resolutionMinutes: 300 }),
    ).toThrow(/sooner/);
    expect(checkSlaTarget(targets.high)).toEqual(targets.high);
  });
});

describe("SupportTicket", () => {
  it("sets due dates in support hours, or around the clock for urgent tickets", () => {
    const normal = raise("normal").snapshot();
    expect(normal.firstResponseDueAt).toEqual(at("2026-11-04T10:00:00Z"));
    const urgent = raise("urgent", at("2026-11-08T12:00:00Z")).snapshot(); // a Sunday
    expect(urgent.firstResponseDueAt).toEqual(at("2026-11-08T12:30:00Z"));
    expect(urgent.businessHours).toBe(false);
  });

  it("needs a way to answer the requester", () => {
    expect(() =>
      SupportTicket.raise(
        { ...raise().snapshot(), requesterEmail: null, requesterPhone: null },
        targets,
        tuesday10,
      ),
    ).toThrow(/email or phone/);
  });

  it("counts the first public reply and waits on the customer, pausing the resolution clock", () => {
    const ticket = raise("high");
    const due = ticket.snapshot().resolutionDueAt;
    ticket.staffReplied(true, null, at("2026-11-03T10:10:00Z"));
    expect(ticket.snapshot().firstRespondedAt).toBeNull();
    ticket.staffReplied(false, null, at("2026-11-03T10:30:00Z"));
    expect(ticket.status).toBe("waiting_on_customer");
    expect(ticket.snapshot().firstRespondedAt).toEqual(at("2026-11-03T10:30:00Z"));
    // Two support hours waiting move the resolution target two support hours on.
    ticket.customerReplied(at("2026-11-03T12:30:00Z"));
    expect(ticket.status).toBe("open");
    expect(ticket.snapshot().resolutionDueAt).toEqual(addSupportMinutes(due, 120));
  });

  it("records each breach once, never while waiting on the customer", () => {
    const ticket = raise("high");
    expect(ticket.checkSla(at("2026-11-03T12:01:00Z"))).toEqual(["first_response"]);
    expect(ticket.checkSla(at("2026-11-03T12:30:00Z"))).toEqual([]);
    ticket.staffReplied(false, null, at("2026-11-03T12:40:00Z"));
    expect(ticket.checkSla(at("2026-11-06T12:00:00Z"))).toEqual([]);
    ticket.customerReplied(at("2026-11-06T12:00:00Z"));
    expect(ticket.checkSla(at("2026-11-09T12:00:00Z"))).toEqual(["resolution"]);
  });

  it("escalates, resolves, reopens on a customer reply and is rated once", () => {
    const ticket = raise();
    ticket.escalate(
      {
        requestId: "req-1",
        sentryUrl: null,
        note: "500 on save",
        by: "staff",
        at: tuesday10.toISOString(),
      },
      tuesday10,
    );
    expect(ticket.status).toBe("escalated");
    ticket.staffReplied(false, null, at("2026-11-03T11:00:00Z"));
    expect(ticket.status).toBe("escalated");
    expect(() => ticket.rate(5, null, tuesday10)).toThrow(/once it is resolved/);
    ticket.setStatus("resolved", at("2026-11-03T15:00:00Z"));
    ticket.customerReplied(at("2026-11-03T16:00:00Z"));
    expect(ticket.status).toBe("open");
    expect(ticket.snapshot().resolvedAt).toBeNull();
    ticket.setStatus("resolved", at("2026-11-03T17:00:00Z"));
    ticket.rate(4, "Quick", at("2026-11-03T17:30:00Z"));
    expect(() => ticket.rate(5, null, tuesday10)).toThrow(/already rated/);
    expect(() => raise().rate(6, null, tuesday10)).toThrow();
  });

  it("moves its targets with a new priority", () => {
    const ticket = raise("low");
    ticket.reprioritise("high", targets);
    expect(ticket.snapshot().firstResponseDueAt).toEqual(at("2026-11-03T12:00:00Z"));
    ticket.reprioritise("urgent", targets);
    expect(ticket.snapshot().firstResponseDueAt).toEqual(at("2026-11-03T10:30:00Z"));
    expect(ticket.snapshot().businessHours).toBe(false);
  });

  it("resolves a ticket left waiting a week and closes one resolved a week", () => {
    const ticket = raise();
    ticket.staffReplied(false, null, tuesday10);
    expect(ticket.housekeeping(at("2026-11-09T10:00:00Z"))).toBeNull();
    expect(ticket.housekeeping(at("2026-11-10T10:00:00Z"))).toBe("resolved");
    expect(ticket.housekeeping(at("2026-11-17T10:00:00Z"))).toBe("closed");
    expect(() => ticket.customerReplied(at("2026-11-18T10:00:00Z"))).toThrow(/closed/);
  });

  it("keeps a ticket raised in the app with its tenant", () => {
    const ticket = SupportTicket.raise(
      { ...raise().snapshot(), tenantId: "t-1", tenantUserId: "u-1" },
      targets,
      tuesday10,
    );
    expect(() => ticket.linkTenant("t-2")).toThrow(/stays with its tenant/);
  });
});

describe("canned responses and escalation links", () => {
  it("fill the placeholders they know", () => {
    expect(
      renderCanned(
        "Hi {{requesterName}}, re {{ ticketNumber }} for {{businessName}}. {{other}} — {{staffName}}",
        {
          requesterName: "Ama",
          ticketNumber: "AF-SUP-2026-000001",
          staffName: "Kojo",
          businessName: null,
        },
      ),
    ).toBe("Hi Ama, re AF-SUP-2026-000001 for your business. {{other}} — Kojo");
  });

  it("accept https links only", () => {
    expect(checkEscalationLink(null)).toBeNull();
    expect(checkEscalationLink("https://sentry.io/issues/1")).toBe("https://sentry.io/issues/1");
    expect(() => checkEscalationLink("http://sentry.io")).toThrow(/https/);
    expect(() => checkEscalationLink("not a link")).toThrow(/web address/);
  });
});
