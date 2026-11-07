                  {/* Clutch Bar (Gearhead Mode) */}
                  {ui.gameMode === 'gearhead' && (
                    <div className="flex-1 h-2 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                      <div
                        className="h-full bg-amber-400 transition-all duration-75"
                        style={{ width: `${Math.round(ui.clutch * 100)}%` }}
                      />
                    </div>
                  )}
                  {/* Throttle Bar */}
                  <div className="flex-1 h-2 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
                    <div
                      className="h-full bg-[#39ff14] transition-all duration-75"
                      style={{ width: `${Math.round(ui.throttle * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Bottom Center Gear & Odometer Bar */}
              <div className="w-full px-4 pt-2 border-t border-gray-800/80 flex items-center justify-between font-hud text-sm text-gray-400">
                <span>482 km</span>
                <div className="px-4 py-0.5 rounded-t-lg bg-gradient-to-t from-red-950/60 to-transparent border-b-2 border-red-500 font-tech italic text-2xl font-black text-white">
                  {formatGear(ui.gear)}
                </div>
                <span>Trip A 163.7 km</span>
              </div>
            </div>

            {/* RIGHT DIAL: TACHOMETER (RPM & GEAR) */}
            <div className="relative w-[360px] h-[360px] rounded-full bg-gradient-to-b from-[#121217] to-[#050508] border-[4px] border-[#2c2c34] dial-shadow flex items-center justify-center">
              {/* Outer Glowing Crimson Ring */}
              <div className="absolute inset-2 rounded-full border border-red-600/35 pointer-events-none" />

              {/* Tachometer Ticks & Numbers (0 to 10 x1000 RPM) */}
              {rpmLabels.map((val, i) => {
                const angle = -135 + (i / (rpmLabels.length - 1)) * 270;
                const rad = ((angle - 90) * Math.PI) / 180;
                const numRadius = 132;
                const x = Math.cos(rad) * numRadius;
                const y = Math.sin(rad) * numRadius;
                const isRedlineZone = val >= 8;

                return (
                  <React.Fragment key={val}>
                    {/* Major Tick */}
                    <div
                      className="absolute w-full h-full top-0 left-0 pointer-events-none"
                      style={{ transform: `rotate(${angle}deg)` }}
                    >
                      <div
                        className={`mx-auto mt-3 w-[3.5px] h-4 rounded-full ${
                          isRedlineZone
                            ? 'bg-red-500 shadow-[0_0_10px_#ff0000]'
                            : 'bg-gray-200'
                        }`}
                      />
                    </div>
                    {/* Number Label */}
                    <div
                      className={`absolute font-tech text-base font-bold italic ${
                        isRedlineZone
                          ? 'text-red-500 drop-shadow-[0_0_8px_rgba(255,0,0,0.8)]'
                          : 'text-gray-100'
                      }`}
                      style={{
                        transform: `translate(${x}px, ${y}px)`,
                      }}
                    >
                      {val}
                    </div>
                  </React.Fragment>
                );
              })}

              {/* Tachometer Needle */}
              <div
                className="absolute inset-0 pointer-events-none transition-transform duration-75 ease-out"
                style={{ transform: `rotate(${rpmAngle}deg)` }}
              >
                <div className="mx-auto mt-7 w-1.5 h-36 bg-gradient-to-b from-white via-red-500 to-red-900 rounded-full shadow-[0_0_18px_#ff1a1a]" />
              </div>

              {/* Center Digital Gear & RPM Hub */}
              <div className="w-44 h-44 rounded-full bg-gradient-to-b from-[#0c0c10] to-[#040406] border border-gray-800 shadow-[inset_0_0_30px_rgba(0,0,0,0.95)] flex flex-col items-center justify-center z-10">
                <div className="flex items-center gap-2">
                  <span className="font-tech italic text-6xl font-black text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.25)]">
                    {formatGear(ui.gear)}
                  </span>
                  {ui.rpm >= 8200 && ui.gear < 6 && (
                    <span className="text-red-500 text-2xl animate-bounce">▲</span>
                  )}
                </div>
                <span className="font-hud text-xs font-semibold text-gray-400 tracking-widest mt-0.5">
                  x1000 RPM ({Math.round(ui.rpm)})
                </span>
              </div>
            </div>
          </div>

          {/* Bottom Controller Quick Legend */}
          <div className="w-full flex items-center justify-between px-6 text-[11px] font-tech text-gray-400 tracking-wider z-20">
            <div>START: IGNITION ON/OFF</div>
            <div>RT: THROTTLE | L-STICK DOWN: BRAKE | LT: CLUTCH</div>
            <div>RB / LB: SHIFT UP / DOWN | D-PAD RIGHT: DRIVE MODE</div>
          </div>
        </div>
      </div>
    </>
  );
}