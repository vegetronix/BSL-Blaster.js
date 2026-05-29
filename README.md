# BSL-Blaster.js

If you've made it to this repo - you already know that the official 
BSL-Scripter software from TI sucks! I couldn't get it to work, and
didn't want to fix their crappy C code. 

As a result, we rewrote our own from scratch, based on the 
MSP430™ FRAM Devices Bootloader (BSL) specification document. 

[Link Text](https://www.ti.com/lit/ug/slau550ab/slau550ab.pdf)

The code is javascript for node, and was developed and tested on Ubuntu 24.  

I've successfully flashed MSP430FR2476 processors with it.  

The code is simple and easy to follow and modify.

Example Invocation: 

node nbsl.js firmware.txt /dev/ttyUSB0
