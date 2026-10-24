# F16-wepon-mod

add AIM-9X and bullet into GeoFS default F16.

Yes this also work in 4.0.

# Keybind

"u" -> Toggle on/off.

" \ " -> Shoot.

"-" / "="  -> Switch wepon.

"," / "/" -> Next target.

"t" -> Radar toggle.

"Shift + u" -> Refill current wepon.


# Menu

Menu page can be find in "Option -> General" 

## Multiplayer missile sync

Multiplayer sync lets two players using this add-on see a simplified incoming missile and receive hit notifications. It uses GeoFS's **public chat** to carry short sync messages; it does not create a private room or hide messages from other players.

### Connect two players

Its important that you ***MUST*** have GeoFS Account.

1. Both players should load the same, current `F16EEGS.js` version and join the same GeoFS multiplayer session.

2. In GeoFS **Options -> General**, find the add-on's **A/A Combat Simulation** controls.
   
3. On one client, select **Generate Group Code**. Share that 16-character code privately with the other player. The other player must enter the exact same code. Do not generate separate codes for each client.
   
4. On both clients, enter the **16 character code** and enable **Enable multiplayer missile sync**.
   
5. Select **Send Sync Test** on one client. The other client should display **MULTIPLAYER SYNC TEST RECEIVED**.
    
6. To sync a missile, the attacker selects a player aircraft as a target and launches a missile while target mode is on. The targeted player should see the incoming missile effect; a hit is reported with the attacker's callsign when GeoFS provides it.

The code is saved in each browser's local storage. If either player changes it, both clients must use the same new code.
