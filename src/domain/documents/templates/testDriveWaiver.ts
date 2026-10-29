/** System template: the waiver a test driver signs before driving a vehicle (version 1). */
export const TEST_DRIVE_WAIVER_V1 = `<h1 class="center">Test drive waiver</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}}</p>

<h2>Driver and vehicle</h2>
<table>
  <tr><th data-width="30">Driver</th><td>{{driver.name}}, {{driver.phone}}</td></tr>
  <tr><th>Driving licence</th><td>{{driver.licenceNumber}}, valid until {{date driver.licenceExpiresOn}}</td></tr>
  <tr><th>Vehicle</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}{{#if vehicle.plateNumber}}, {{upper vehicle.plateNumber}}{{/if}}</td></tr>
  <tr><th>Drive</th><td>{{drive.startsAt}} to {{drive.endsAt}}, with {{drive.accompaniedBy}}</td></tr>
  <tr><th>Odometer out</th><td>{{number drive.odometerOut}}</td></tr>
</table>

<section data-clause="test_drive_terms" data-title="The driver's undertaking" data-locked>
<p>The driver confirms that the licence shown is theirs and valid, that they are fit to drive and not under the influence of alcohol or drugs, and that they will follow the route and directions of the staff member with them and obey the road traffic rules.</p>
<p>The driver is responsible for traffic offences committed during the drive and for loss or damage caused by their negligence or by breaking these terms, up to the cost of repair.</p>
</section>

<signature-block>
  <signer role="business" label="For the dealer" name="{{drive.accompaniedBy}}"></signer>
  <signer role="driver" label="Driver" name="{{driver.name}}"></signer>
</signature-block>
`;
