/** System template: the vehicle's return from a rental, signed at check-in (version 1). */
export const RENTAL_RETURN_V1 = `<h1 class="center">Vehicle return</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}} · booking {{rental.number}}{{#if rental.agreementNumber}} · agreement {{rental.agreementNumber}}{{/if}}</p>

<h2>Parties</h2>
<table>
  <tr><th data-width="30">Owner</th><td>{{issuer.name}}{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}</td></tr>
  <tr><th>Renter</th><td>{{renter.name}} ({{renter.code}})</td></tr>
  <tr><th>Driver</th><td>{{driver.name}}</td></tr>
</table>

<h2>Vehicle and return</h2>
<table>
  <tr><th data-width="30">Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>
  <tr><th>Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  <tr><th>Returned</th><td>{{date rental.returnedOn}}, {{rental.returnedTime}} at {{rental.branch}}</td></tr>
  <tr><th>Due back</th><td>{{date rental.dueOn}}, {{rental.dueTime}}</td></tr>
  <tr><th>Odometer</th><td>{{number rental.odometerOut}} out, {{number rental.odometerIn}} back ({{number rental.km}} {{rental.unit}} driven)</td></tr>
  <tr><th>Fuel</th><td>{{rental.fuelOut}} out, {{rental.fuelIn}} back</td></tr>
</table>

<h2>Condition at the return</h2>
<table>
  <thead><tr><th data-width="8">#</th><th data-width="52">Item</th><th data-width="15">OK</th><th>Note</th></tr></thead>
  <tbody>
  {{#each checklist}}<tr><td>{{@number}}</td><td>{{label}}</td><td>{{ok}}</td><td>{{note}}</td></tr>
  {{/each}}
  </tbody>
</table>
{{#if damages}}
<p><strong>New damage found at the return:</strong></p>
<ul>
{{#each damages}}<li>{{area}} ({{severity}}): {{description}}{{#if estimate}}, estimated at {{money estimate}}{{/if}}</li>
{{/each}}
</ul>
{{else}}
<p>No new damage was found at the return.</p>
{{/if}}

{{#if charges}}
<h2>Charges at the return</h2>
<table>
  <thead><tr><th data-width="70">Item</th><th>Amount</th></tr></thead>
  <tbody>
  {{#each charges}}<tr><td>{{description}}</td><td>{{money amount}}</td></tr>
  {{/each}}
  </tbody>
</table>
{{/if}}
<p>The rental has charged <strong>{{money rental.total}}</strong> in all; the invoice follows when the booking is closed.</p>

<section data-clause="return_acknowledgement" data-title="Acknowledgement" data-locked>
<p>Both sides confirm the vehicle was returned on the date and in the condition recorded above. Damage estimates are replaced by the final repair cost once known.</p>
</section>

<signature-block>
  <signer role="business" label="For the owner" name="{{issuer.name}}"></signer>
  <signer role="renter" label="Renter" name="{{rental.signatory}}"></signer>
</signature-block>
`;
