(* Minimal live-I/O-map program (ENDPOINTS.md section 4/6): inputs are coils 100+ (%QX12.4..), outputs coils 0+ (%QX0.0..). *)
PROGRAM Main
  VAR
    high_sensor    AT %QX12.4 : BOOL;   (* inputs from the plant: coils 100+ *)
    low_sensor     AT %QX12.5 : BOOL;
    start_btn      AT %QX13.4 : BOOL;
    stop_btn       AT %QX13.6 : BOOL;   (* normally closed *)
    conveyor_entry AT %QX0.0  : BOOL;   (* outputs to the plant: coils 0+ *)
    start_light    AT %QX0.7  : BOOL;
    counter        AT %QW0    : INT;
  END_VAR
  VAR
    running : BOOL := FALSE;
    t_on : TON;
    edge : R_TRIG;
  END_VAR
  IF start_btn THEN running := TRUE; END_IF;
  IF NOT stop_btn THEN running := FALSE; END_IF;
  t_on(IN := running, PT := T#500ms);
  edge(CLK := low_sensor);
  IF edge.Q THEN counter := counter + 1; END_IF;
  conveyor_entry := t_on.Q AND NOT high_sensor;
  start_light := running;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM inst0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
