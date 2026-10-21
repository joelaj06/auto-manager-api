/** System template: work & pay (hire purchase) agreement (version 2: guarantors sign). */
export const WORKPAY_AGREEMENT_V2 = `<h1 class="center">Work and pay agreement</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}}</p>

<p>This agreement is made between <strong>{{issuer.name}}</strong>{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}, the owner, and <strong>{{driver.name}}</strong>{{#if driver.ghanaCardNumber}} (Ghana Card {{driver.ghanaCardNumber}}){{/if}}, the driver, for the vehicle below.</p>

<h2>Vehicle</h2>
<table>
  <tr><th data-width="30">Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>
  <tr><th>Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  <tr><th>Chassis / VIN</th><td>{{vehicle.vin}}</td></tr>
  <tr><th>Engine number</th><td>{{vehicle.engineNumber}}</td></tr>
</table>

<h2>Price and payments</h2>
<table>
  <tr><th data-width="40">Price</th><td>{{money agreement.price}}</td></tr>
  <tr><th>Deposit</th><td>{{money agreement.deposit}}</td></tr>
  <tr><th>Amount to be paid in instalments</th><td>{{money agreement.financed}}</td></tr>
  <tr><th>Instalments</th><td>{{agreement.instalments}} × {{money agreement.instalment}}, {{agreement.frequency}}</td></tr>
  <tr><th>First and last due dates</th><td>{{date agreement.firstDueOn}} to {{date agreement.lastDueOn}}</td></tr>
  <tr><th>Grace period</th><td>{{agreement.graceDays}} days</td></tr>
</table>

<section data-clause="ownership_until_paid" data-title="Ownership" data-locked>
<p>The vehicle remains the property of the owner until every amount under this agreement has been paid. Ownership passes to the driver only by a transfer letter signed by both parties after the final payment. The driver may not sell, pledge, rent out or hand the vehicle to anyone else without the owner's written consent.</p>
</section>

<section data-clause="payments" data-title="Payments">
<p>The driver pays each instalment on or before its due date by an agreed method. A payment is applied first to penalties, then to overdue instalments, then to the current instalment, then to future instalments.</p>
</section>

<section data-clause="default_and_repossession" data-title="Default and repossession" data-locked>
<p>If an instalment remains unpaid after the grace period, or the driver breaks this agreement in a serious way, the owner may give written notice. If the default is not remedied within the time stated in the notice, the owner may take back the vehicle. Amounts already paid are then dealt with as set out in the owner's written settlement statement.</p>
</section>

<section data-clause="maintenance_and_insurance" data-title="Maintenance and insurance">
<p>The driver keeps the vehicle in good repair, services it on time and reports any accident or damage at once. Insurance, road worthiness and registration are kept valid as agreed between the parties.</p>
<p>Maintenance and repairs are paid by: <strong>{{agreement.maintenance}}</strong>. Insurance is paid by: <strong>{{agreement.insurance}}</strong>.</p>
</section>

{{#if guarantors}}
<h2>Guarantors</h2>
<table>
  <thead><tr><th>Name</th><th>Phone</th><th>Relationship</th></tr></thead>
  <tbody>
  {{#each guarantors}}<tr><td>{{name}}</td><td>{{phone}}</td><td>{{relationship}}</td></tr>
  {{/each}}
  </tbody>
</table>
{{/if}}

<div class="page-break"></div>
<h2>Payment schedule</h2>
<table>
  <thead><tr><th data-width="12">#</th><th data-width="48">Due on</th><th>Amount</th></tr></thead>
  <tbody>
  {{#each schedule}}<tr><td>{{number}}</td><td>{{date dueOn}}</td><td>{{money amount}}</td></tr>
  {{/each}}
  </tbody>
</table>

<signature-block>
  <signer role="owner" label="Owner" name="{{issuer.name}}"></signer>
  <signer role="driver" label="Driver" name="{{driver.name}}"></signer>
  {{#each guarantors}}<signer role="guarantor_{{@number}}" label="Guarantor" name="{{name}}"></signer>
  {{/each}}
</signature-block>
`;
