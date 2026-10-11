(* MongoMation sample: single belt conveyor with jam detection.
   Target: OpenPLC v3 (matiec/iec2c) and OpenPLC v4 (STruC++).
   I/O map follows the OpenPLC v3 "slave device" convention
   (%IX100.0 / %QX100.0 / %IW100 / %QW100) so the same file works on
   v3 (Slave Devices page) and v4 (modbus_master plugin, iec_location). *)

PROGRAM conveyor_ctrl
  VAR
    (* Factory I/O sensors -> Modbus discrete inputs 0..5 *)
    start_pb     AT %IX100.0 : BOOL;  (* Start push button, NO *)
    stop_pb_nc   AT %IX100.1 : BOOL;  (* Stop push button, NC: TRUE = not pressed *)
    estop_nc     AT %IX100.2 : BOOL;  (* Emergency stop, NC: TRUE = healthy *)
    entry_sensor AT %IX100.3 : BOOL;  (* Diffuse sensor at belt entry *)
    exit_sensor  AT %IX100.4 : BOOL;  (* Diffuse sensor at belt exit *)
    reset_pb     AT %IX100.5 : BOOL;  (* Fault reset push button, NO *)

    (* Factory I/O actuators <- Modbus coils 0..3 *)
    conveyor_run AT %QX100.0 : BOOL;  (* Belt conveyor motor *)
    run_light    AT %QX100.1 : BOOL;
    fault_light  AT %QX100.2 : BOOL;
    estop_light  AT %QX100.3 : BOOL;

    (* Factory I/O register outputs <- Modbus holding registers 0.. *)
    part_count_out AT %QW100 : INT;   (* e.g. a digital display *)

    (* Internal state *)
    running    : BOOL := FALSE;
    fault      : BOOL := FALSE;
    part_count : INT := 0;

    start_edge : R_TRIG;
    reset_edge : R_TRIG;
    part_edge  : R_TRIG;
    jam_timer  : TON;
    part_ctr   : CTU;
  END_VAR
  VAR CONSTANT
    JAM_TIME : TIME := T#5s;
    MAX_PARTS : INT := 32000;
  END_VAR

  (* Edge detection on push buttons and the exit sensor *)
  start_edge(CLK := start_pb);
  reset_edge(CLK := reset_pb);
  part_edge(CLK := exit_sensor);

  (* Jam detection: entry sensor blocked for longer than JAM_TIME while running *)
  jam_timer(IN := running AND entry_sensor, PT := JAM_TIME);

  (* Fault latch: set by jam or e-stop, reset only by a rising edge on reset
     while the e-stop circuit is healthy *)
  IF jam_timer.Q OR NOT estop_nc THEN
    fault := TRUE;
  ELSIF reset_edge.Q AND estop_nc THEN
    fault := FALSE;
  END_IF;

  (* Start/stop seal-in with interlocks *)
  IF fault OR NOT stop_pb_nc OR NOT estop_nc THEN
    running := FALSE;
  ELSIF start_edge.Q THEN
    running := TRUE;
  END_IF;

  (* Part counter on the exit sensor *)
  part_ctr(CU := part_edge.Q, R := reset_edge.Q AND NOT fault, PV := MAX_PARTS);
  part_count := part_ctr.CV;

  (* Outputs *)
  conveyor_run := running;
  run_light := running;
  fault_light := fault;
  estop_light := NOT estop_nc;
  part_count_out := part_count;
END_PROGRAM


CONFIGURATION Config0

  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : conveyor_ctrl;
  END_RESOURCE
END_CONFIGURATION
