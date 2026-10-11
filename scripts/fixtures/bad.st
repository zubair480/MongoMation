(* Deliberately invalid: undeclared variable + type error, to check CompileRejected diagnostics. *)
PROGRAM Main
  VAR
    conveyor_entry AT %QX0.0 : BOOL;
    n : INT;
  END_VAR
  conveyor_entry := undeclared_thing;
  n := TRUE + 1.5;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM inst0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
