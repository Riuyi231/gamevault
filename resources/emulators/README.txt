Emuladores incluidos en GameVault
=================================

Este directorio contiene los emuladores portables que se empaquetan dentro
del instalador (RetroArch + cores, PCSX2, Dolphin).

Los binarios NO se guardan en git. Para generarlos ejecuta:

    npm run fetch-emulators

Esto descarga RetroArch 1.22.2 (+ pack de cores), PCSX2 v2.8.0 y
Dolphin 2606a y los deja listos aquí. El build empaqueta esta carpeta en
`<app>/resources/emulators`.

Las ROMs NO se distribuyen dentro del instalador. El launcher crea carpetas
`roms/<consola>` en los datos del usuario; solo tienes que colocar ahí tus
propias ROMs y la app las escaneará automáticamente.