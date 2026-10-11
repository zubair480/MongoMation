PROGRAM main
  VAR level AT %IW100 : INT; END_VAR
  VAR pct : REAL; high : BOOL; END_VAR
  pct := INT_TO_REAL(level) / 100.0;
  high := pct > 80;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
