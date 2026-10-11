PROGRAM main
  VAR_EXTERNAL
    g_sensor : BOOL;
    g_lamp : BOOL;
  END_VAR
  g_lamp := g_sensor;
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL
    g_sensor AT %IX100.0 : BOOL;
    g_lamp AT %QX100.0 : BOOL;
  END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
