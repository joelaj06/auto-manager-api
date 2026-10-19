import { describe, expect, it } from "vitest";
import { Customer, type CustomerDetails } from "./Customer.js";
import { DEFAULT_DRIVER_RULES, Driver, type DriverDetails } from "./Driver.js";
import { checkPayout, maskGhanaCard, parseGhanaCard } from "./PartyDetails.js";

const now = new Date("2026-10-19T09:00:00Z");
const today = "2026-10-19";

const driverDetails: DriverDetails = {
  firstName: " Kwame ",
  lastName: "Mensah",
  otherNames: null,
  phone: "024 123 4567",
  altPhone: null,
  email: "KWAME@Example.com",
  dateOfBirth: null,
  gender: "male",
  address: null,
  ghanaCardNumber: "gha 123456789 1",
  licenceNumber: "dl-998",
  licenceClass: "B",
  licenceIssuedOn: "2022-01-01",
  licenceExpiresOn: "2027-01-01",
  employmentType: "remittance",
  hiredOn: null,
  emergencyContact: null,
  payout: null,
  tags: [],
  notes: null,
};

const register = (details: Partial<DriverDetails> = {}) =>
  Driver.register({
    id: "d1",
    code: "DRV-00001",
    branchId: "b1",
    details: { ...driverDetails, ...details },
    createdBy: "u1",
    now,
  }).driver;

describe("party details", () => {
  it("normalises and masks Ghana Card numbers", () => {
    expect(parseGhanaCard("gha-123456789-1")).toBe("GHA-123456789-1");
    expect(maskGhanaCard("GHA-123456789-1")).toBe("GHA-•••••6789-1");
    expect(() => parseGhanaCard("GHA-12345-1")).toThrow(/GHA-123456789-1/);
  });

  it("needs a network with a mobile money number", () => {
    const empty = {
      momoNumber: null,
      momoNetwork: null,
      momoName: null,
      bankName: null,
      bankBranch: null,
      accountName: null,
      accountNumber: null,
    } as const;
    expect(checkPayout(empty)).toBeNull();
    expect(() => checkPayout({ ...empty, momoNumber: "0241234567" })).toThrow(/network/);
    expect(checkPayout({ ...empty, momoNumber: "0241234567", momoNetwork: "mtn" })).toMatchObject({
      momoNumber: "+233241234567",
    });
  });
});

describe("Driver", () => {
  it("registers as an applicant with normalised details", () => {
    expect(register().snapshot()).toMatchObject({
      firstName: "Kwame",
      phone: "+233241234567",
      email: "kwame@example.com",
      ghanaCardNumber: "GHA-123456789-1",
      licenceNumber: "DL-998",
      status: "applicant",
    });
  });

  it("activates only with onboarding complete", () => {
    const driver = register({ licenceExpiresOn: "2026-01-01" });
    const checklist = driver.onboarding(
      { guarantors: 0, documentTypes: [] },
      { ...DEFAULT_DRIVER_RULES, requiredDocuments: ["police_report"] },
      today,
    );
    expect(checklist.filter((i) => !i.done).map((i) => i.key)).toEqual([
      "licence",
      "guarantors",
      "document:police_report",
    ]);
    expect(() => driver.changeStatus("active", { reason: null, today, now, checklist })).toThrow(
      /Complete onboarding first/,
    );

    const ready = register();
    const done = ready.onboarding(
      { guarantors: 1, documentTypes: [] },
      DEFAULT_DRIVER_RULES,
      today,
    );
    ready.changeStatus("active", { reason: null, today, now, checklist: done });
    expect(ready.snapshot()).toMatchObject({ status: "active", hiredOn: today });
  });

  it("needs reasons to suspend, terminate and rehire, and cannot skip steps", () => {
    const driver = register();
    expect(() => driver.changeStatus("suspended", { reason: "late", today, now })).toThrow(
      /applicant cannot become suspended/,
    );
    driver.changeStatus("active", { reason: null, today, now, checklist: [] });
    expect(() => driver.changeStatus("suspended", { reason: null, today, now })).toThrow(/reason/);
    driver.changeStatus("suspended", { reason: "Shortfalls", today, now });
    expect(() => driver.remove("mistake", now)).toThrow(/Terminate/);
    driver.changeStatus("terminated", { reason: "Left the company", today, now });
    expect(driver.snapshot().terminatedOn).toBe(today);
    driver.changeStatus("applicant", { reason: "Coming back", today, now });
    expect(driver.snapshot().terminatedOn).toBeNull();
  });
});

describe("Customer", () => {
  const details: CustomerDetails = {
    type: "individual",
    firstName: "Ama",
    lastName: "Owusu",
    companyName: null,
    phone: "0201234567",
    altPhone: null,
    email: null,
    address: null,
    dateOfBirth: null,
    occupation: null,
    ghanaCardNumber: null,
    licenceNumber: null,
    licenceClass: null,
    licenceExpiresOn: null,
    registrationNumber: null,
    tin: null,
    contactPerson: null,
    creditLimitMinor: null,
    paymentTermsDays: null,
    source: null,
    homeBranchId: null,
    tags: [],
    notes: null,
  };
  const register = (d: Partial<CustomerDetails> = {}) =>
    Customer.register({
      id: "c1",
      code: "CUS-00001",
      details: { ...details, ...d },
      createdBy: null,
      now,
    });

  it("names individuals and companies, and keeps credit terms for companies", () => {
    expect(register().snapshot().name).toBe("Ama Owusu");
    expect(
      register({ type: "corporate", companyName: "Acme Ltd", creditLimitMinor: 500_000 }).snapshot()
        .name,
    ).toBe("Acme Ltd");
    expect(() => register({ creditLimitMinor: 100 })).toThrow(/corporate/);
    expect(() => register({ phone: null })).toThrow(/phone number or an email/);
  });

  it("blacklists with a reason and refuses new business", () => {
    const customer = register();
    expect(() => customer.setRisk("blacklisted", "", now)).toThrow(/reason/);
    customer.setRisk("blacklisted", "Unpaid rental", now);
    expect(() => customer.assertAllowed()).toThrow(/blacklisted: Unpaid rental/);
    customer.setRisk("ok", "Paid in full", now);
    expect(customer.snapshot()).toMatchObject({ riskStatus: "ok", riskReason: null });
    expect(() => customer.assertAllowed()).not.toThrow();
  });
});
