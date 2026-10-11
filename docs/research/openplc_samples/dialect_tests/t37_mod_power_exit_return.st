PROGRAM main
  VAR i : INT; r : REAL; k : INT; END_VAR
  i := 17 MOD 5;
  r := 2.0 ** 3.0;
  FOR k := 0 TO 10 DO
    IF k = 5 THEN EXIT; END_IF;
  END_FOR;
  IF i = 2 THEN RETURN; END_IF;
  i := i + 1;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
