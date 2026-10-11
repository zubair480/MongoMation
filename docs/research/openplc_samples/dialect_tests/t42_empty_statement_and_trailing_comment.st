PROGRAM main
  VAR x : BOOL; END_VAR
  ;
  x := NOT x;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
(* trailing comment after configuration *)
