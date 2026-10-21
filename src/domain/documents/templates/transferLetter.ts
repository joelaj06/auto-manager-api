/** System template: transfer letter of agreement (decision 7; version 1). */
export const TRANSFER_LETTER_V1 = `<h1 class="center">Transfer letter of agreement</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}}</p>

<h2>Parties</h2>
<table>
  <tr><th data-width="30">Owner</th><td>{{issuer.name}}{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}</td></tr>
  <tr><th>Driver</th><td>{{driver.name}}{{#if driver.ghanaCardNumber}}, Ghana Card {{driver.ghanaCardNumber}}{{/if}}{{#if driver.address}}, {{driver.address}}{{/if}}</td></tr>
</table>

<h2>Vehicle</h2>
<table>
  <tr><th data-width="30">Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>
  <tr><th>Make, model and year</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  <tr><th>Colour</th><td>{{vehicle.colour}}</td></tr>
  <tr><th>Chassis / VIN</th><td>{{vehicle.vin}}</td></tr>
  <tr><th>Engine number</th><td>{{vehicle.engineNumber}}</td></tr>
  <tr><th>Odometer at transfer</th><td>{{number transfer.odometer}} {{transfer.unit}}</td></tr>
</table>

<h2>Agreement</h2>
<p>Work and pay agreement <strong>{{agreement.number}}</strong> started on {{date agreement.startDate}}. The driver has paid <strong>{{money agreement.totalPaid}}</strong> in full, the final payment on {{date agreement.finalPaymentOn}}.</p>

<section data-clause="transfer_of_ownership" data-title="Transfer of ownership" data-locked>
<p>The owner transfers full ownership of the vehicle above to the driver, together with every right in it, from the date this letter is signed by both parties.</p>
</section>

<section data-clause="no_further_amount" data-title="No further amount owed" data-locked>
<p>Both parties confirm that no further amount is owed under the work and pay agreement named above.</p>
</section>

<section data-clause="condition" data-title="Condition of the vehicle">
<p>The driver has had the vehicle in their possession and accepts it in its current condition{{#if transfer.condition}}: {{transfer.condition}}{{/if}}.</p>
</section>

<h2>Documents and items handed over</h2>
<table>
  <thead><tr><th data-width="70">Item</th><th>Handed over</th></tr></thead>
  <tbody>
  {{#each handedOver}}<tr><td>{{item}}</td><td>{{included}}</td></tr>
  {{/each}}
  </tbody>
</table>

<section data-clause="dvla_responsibility" data-title="Change of ownership at the DVLA" data-locked>
<p>The driver arranges the change of ownership with the Driver and Vehicle Licensing Authority and pays its costs, unless both parties agree otherwise in writing. The owner signs the forms the DVLA requires for the transfer.</p>
</section>

<signature-block>
  <signer role="owner" label="Owner" name="{{issuer.name}}"></signer>
  <signer role="driver" label="Driver" name="{{driver.name}}"></signer>
  <signer role="witness" label="Witness (optional)" name=""></signer>
</signature-block>
`;
