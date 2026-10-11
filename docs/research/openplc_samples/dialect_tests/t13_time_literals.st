PROGRAM main
  VAR
    t1 : TIME := T#5s; t2 : TIME := TIME#5s; t3 : TIME := t#1m30s; t4 : TIME := T#1.5s; t5 : TIME := T#500MS; t6 : TIME := T#1h2m3s4ms;
  END_VAR
  t1 := t2 + t3;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
